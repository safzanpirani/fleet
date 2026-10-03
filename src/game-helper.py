# fleet game helper. Runs inside the logged-in console session on Windows,
# started by `fleet game <host> start` through an Interactive scheduled task.
#
# ssh lands in session 0, where SendInput reaches no desktop, and a ViGEm
# virtual pad lives only as long as the process that plugged it in. So one
# resident process here owns all game input: scan-code keys, relative mouse,
# mouse buttons, a virtual Xbox 360 pad, and window frames. fleet talks to it
# over 127.0.0.1 with the token in state.json: one JSON request line in, one
# JSON reply line out.
#
# Safety rules this file enforces:
#  - Keyboard and mouse input require the target foreground. Before each
#    keyboard or mouse event the foreground window is re-read; when the target
#    lost the foreground, the run aborts and everything held is released.
#  - Anything still held after a call auto-releases when its lease runs out.
#  - A detached macro run releases everything when it ends, fails or is halted.
import base64, ctypes, ctypes.wintypes as W, hashlib, io, json, os, secrets, socket
import select, socketserver, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, "state.json")
LOG = os.path.join(HERE, "helper.log")
with open(os.path.abspath(__file__), "rb") as _f:
    VERSION = hashlib.sha256(_f.read()).hexdigest()[:12]

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
winmm = ctypes.WinDLL("winmm")
dwmapi = ctypes.WinDLL("dwmapi")


def log(msg):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + msg + "\n")
    except OSError:
        pass


# ── Win32 input ───────────────────────────────────────────────────────────────
ULONG_PTR = ctypes.c_size_t


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", W.LONG), ("dy", W.LONG), ("mouseData", W.DWORD), ("dwFlags", W.DWORD),
                ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", W.WORD), ("wScan", W.WORD), ("dwFlags", W.DWORD), ("time", W.DWORD),
                ("dwExtraInfo", ULONG_PTR)]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", W.DWORD), ("wParamL", W.WORD), ("wParamH", W.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", W.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = [W.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = W.UINT
user32.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext.restype = W.BOOL
user32.GetThreadDpiAwarenessContext.restype = ctypes.c_void_p
user32.AreDpiAwarenessContextsEqual.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.AreDpiAwarenessContextsEqual.restype = W.BOOL
user32.GetForegroundWindow.restype = W.HWND
user32.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
user32.GetWindowThreadProcessId.restype = W.DWORD
user32.GetAncestor.argtypes = [W.HWND, W.UINT]
user32.GetAncestor.restype = W.HWND
user32.GetClientRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]
user32.ClientToScreen.argtypes = [W.HWND, ctypes.POINTER(W.POINT)]
user32.IsWindow.argtypes = [W.HWND]
user32.IsWindowVisible.argtypes = [W.HWND]
user32.IsIconic.argtypes = [W.HWND]
user32.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
user32.GetWindowTextLengthW.argtypes = [W.HWND]
user32.GetWindowLongW.argtypes = [W.HWND, ctypes.c_int]
user32.SetForegroundWindow.argtypes = [W.HWND]
user32.BringWindowToTop.argtypes = [W.HWND]
user32.ShowWindow.argtypes = [W.HWND, ctypes.c_int]
user32.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
dwmapi.DwmGetWindowAttribute.argtypes = [W.HWND, W.DWORD, ctypes.c_void_p, W.DWORD]
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.GetCursorPos.argtypes = [ctypes.POINTER(W.POINT)]
user32.WindowFromPoint.argtypes = [W.POINT]
user32.WindowFromPoint.restype = W.HWND
kernel32.CloseHandle.argtypes = [W.HANDLE]
kernel32.OpenProcess.restype = W.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)]

KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, KEYEVENTF_SCANCODE = 0x1, 0x2, 0x4, 0x8
MOUSEEVENTF_MOVE, MOUSEEVENTF_WHEEL = 0x1, 0x800

# Set-1 scan codes by key position, so WASD stays WASD on any layout.
# (code, extended)
SCAN = {"esc": (0x01, 0), "minus": (0x0C, 0), "equals": (0x0D, 0), "backspace": (0x0E, 0),
        "tab": (0x0F, 0), "lbracket": (0x1A, 0), "rbracket": (0x1B, 0), "enter": (0x1C, 0),
        "lctrl": (0x1D, 0), "semicolon": (0x27, 0), "quote": (0x28, 0), "grave": (0x29, 0),
        "lshift": (0x2A, 0), "backslash": (0x2B, 0), "comma": (0x33, 0), "period": (0x34, 0),
        "slash": (0x35, 0), "rshift": (0x36, 0), "nummul": (0x37, 0), "lalt": (0x38, 0),
        "space": (0x39, 0), "capslock": (0x3A, 0), "numlock": (0x45, 0), "scrolllock": (0x46, 0),
        "num7": (0x47, 0), "num8": (0x48, 0), "num9": (0x49, 0), "numsub": (0x4A, 0),
        "num4": (0x4B, 0), "num5": (0x4C, 0), "num6": (0x4D, 0), "numadd": (0x4E, 0),
        "num1": (0x4F, 0), "num2": (0x50, 0), "num3": (0x51, 0), "num0": (0x52, 0),
        "numdot": (0x53, 0), "f11": (0x57, 0), "f12": (0x58, 0),
        "rctrl": (0x1D, 1), "ralt": (0x38, 1), "up": (0x48, 1), "down": (0x50, 1),
        "left": (0x4B, 1), "right": (0x4D, 1), "insert": (0x52, 1), "delete": (0x53, 1),
        "home": (0x47, 1), "end": (0x4F, 1), "pageup": (0x49, 1), "pagedown": (0x51, 1),
        "lwin": (0x5B, 1), "rwin": (0x5C, 1), "apps": (0x5D, 1), "numenter": (0x1C, 1),
        "numdiv": (0x35, 1)}
for _i, _c in enumerate("1234567890"):
    SCAN[_c] = (0x02 + _i, 0)
for _row, _start in (("qwertyuiop", 0x10), ("asdfghjkl", 0x1E), ("zxcvbnm", 0x2C)):
    for _i, _c in enumerate(_row):
        SCAN[_c] = (_start + _i, 0)
for _i in range(10):
    SCAN["f%d" % (_i + 1)] = (0x3B + _i, 0)
for _i, _code in enumerate((0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x76)):
    SCAN["f%d" % (_i + 13)] = (_code, 0)
KEY_ALIAS = {"ctrl": "lctrl", "control": "lctrl", "shift": "lshift", "alt": "lalt", "win": "lwin",
             "escape": "esc", "return": "enter", "del": "delete", "ins": "insert", "pgup": "pageup",
             "pgdn": "pagedown", "`": "grave", "-": "minus", "=": "equals", "[": "lbracket",
             "]": "rbracket", ";": "semicolon", "'": "quote", ",": "comma", ".": "period",
             "/": "slash", "\\": "backslash", "caps": "capslock", "menu": "apps"}
# Mouse buttons: (down flag, up flag, mouseData)
MOUSE = {"lmb": (0x2, 0x4, 0), "rmb": (0x8, 0x10, 0), "mmb": (0x20, 0x40, 0),
         "mb4": (0x80, 0x100, 1), "mb5": (0x80, 0x100, 2)}
MOUSE_ALIAS = {"left": "lmb", "right": "rmb", "middle": "mmb", "x1": "mb4", "x2": "mb5",
               "mouse1": "lmb", "mouse2": "rmb", "mouse3": "mmb", "mouse4": "mb4", "mouse5": "mb5"}
PAD_BUTTONS = {"a": "XUSB_GAMEPAD_A", "b": "XUSB_GAMEPAD_B", "x": "XUSB_GAMEPAD_X", "y": "XUSB_GAMEPAD_Y",
               "lb": "XUSB_GAMEPAD_LEFT_SHOULDER", "rb": "XUSB_GAMEPAD_RIGHT_SHOULDER",
               "ls": "XUSB_GAMEPAD_LEFT_THUMB", "rs": "XUSB_GAMEPAD_RIGHT_THUMB",
               "start": "XUSB_GAMEPAD_START", "back": "XUSB_GAMEPAD_BACK", "guide": "XUSB_GAMEPAD_GUIDE",
               "up": "XUSB_GAMEPAD_DPAD_UP", "down": "XUSB_GAMEPAD_DPAD_DOWN",
               "left": "XUSB_GAMEPAD_DPAD_LEFT", "right": "XUSB_GAMEPAD_DPAD_RIGHT"}
PAD_ALIAS = {"l3": "ls", "r3": "rs", "select": "back", "view": "back", "menu": "start", "home": "guide",
             "l1": "lb", "r1": "rb", "l2": "lt", "r2": "rt"}


class StepError(Exception):
    pass


class Aborted(Exception):
    pass


def norm_key(name):
    """'w' -> ('key','w'); 'lmb' -> ('mouse','lmb'); 'pad.a' -> ('pad','a'); 'pad.lt' -> ('trigger','lt')."""
    if not isinstance(name, str) or not name:
        raise StepError("a key name must be a non-empty string")
    n = name.strip().lower()
    if n.startswith("pad."):
        b = PAD_ALIAS.get(n[4:], n[4:])
        if b in ("lt", "rt"):
            return ("trigger", b)
        if b in PAD_BUTTONS:
            return ("pad", b)
        raise StepError("unknown pad button %r (have %s, lt, rt)" % (name, ", ".join(sorted(PAD_BUTTONS))))
    m = MOUSE_ALIAS.get(n, n)
    if m in MOUSE:
        return ("mouse", m)
    k = KEY_ALIAS.get(n, n)
    if k in SCAN:
        return ("key", k)
    raise StepError("unknown key %r" % name)


def send(*inputs):
    arr = (INPUT * len(inputs))(*inputs)
    sent = user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
    if sent != len(inputs):
        raise StepError("SendInput delivered %d of %d events (error %d): a higher-integrity window "
                        "may be focused, or the desktop is locked" % (sent, len(inputs), ctypes.get_last_error()))


def key_input(name, up):
    code, ext = SCAN[name]
    flags = KEYEVENTF_SCANCODE | (KEYEVENTF_EXTENDEDKEY if ext else 0) | (KEYEVENTF_KEYUP if up else 0)
    i = INPUT(type=1)
    i.u.ki = KEYBDINPUT(0, code, flags, 0, 0)
    return i


def mouse_input(flags, dx=0, dy=0, data=0):
    i = INPUT(type=0)
    i.u.mi = MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
    return i


# ── windows ───────────────────────────────────────────────────────────────────
def window_text(h):
    n = user32.GetWindowTextLengthW(h)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(h, buf, n + 1)
    return buf.value


def window_pid(h):
    pid = W.DWORD()
    user32.GetWindowThreadProcessId(h, ctypes.byref(pid))
    return pid.value


_exe_cache = {}


def exe_of(pid):
    if pid in _exe_cache:
        return _exe_cache[pid]
    name = ""
    hp = kernel32.OpenProcess(0x1000, False, pid)
    if hp:
        buf = ctypes.create_unicode_buffer(1024)
        size = W.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(hp, 0, buf, ctypes.byref(size)):
            name = os.path.basename(buf.value)
        kernel32.CloseHandle(hp)
    if len(_exe_cache) > 512:
        _exe_cache.clear()
    _exe_cache[pid] = name
    return name


def client_rect(h):
    r = W.RECT()
    if not user32.GetClientRect(h, ctypes.byref(r)):
        return None
    p = W.POINT(0, 0)
    if not user32.ClientToScreen(h, ctypes.byref(p)):
        return None
    return (p.x, p.y, r.right - r.left, r.bottom - r.top)


def describe(h):
    pid = window_pid(h)
    rect = client_rect(h) or (0, 0, 0, 0)
    return {"hwnd": int(h), "pid": pid, "exe": exe_of(pid), "title": window_text(h),
            "x": rect[0], "y": rect[1], "width": rect[2], "height": rect[3],
            "minimized": bool(user32.IsIconic(h))}


def top_windows():
    out = []
    WS_EX_TOOLWINDOW = 0x80

    @ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def cb(h, _):
        if not user32.IsWindowVisible(h) or user32.GetAncestor(h, 2) != h:
            return True
        if user32.GetWindowLongW(h, -20) & WS_EX_TOOLWINDOW:
            return True
        cloaked = W.DWORD()
        dwmapi.DwmGetWindowAttribute(h, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if cloaked.value or not window_text(h):
            return True
        d = describe(h)
        if d["minimized"] or (d["width"] > 0 and d["height"] > 0):
            out.append(d)
        return True

    user32.EnumWindows(cb, 0)
    return out


def resolve_target(spec):
    """One window for a target spec, or a StepError naming the candidates."""
    if not isinstance(spec, str) or not spec.strip():
        raise StepError("target must be a non-empty string")
    spec = spec.strip()
    wins = top_windows()
    low = spec.lower()
    if low.startswith("hwnd:"):
        h = int(spec[5:], 0)
        if not user32.IsWindow(h):
            raise StepError("no window %s" % spec)
        return describe(h)
    if low.startswith("pid:"):
        cands = [w for w in wins if w["pid"] == int(spec[4:])]
    elif low.startswith("exe:"):
        want = low[4:]
        cands = [w for w in wins if w["exe"].lower() in (want, want + ".exe")]
    elif low.startswith("title:"):
        cands = [w for w in wins if low[6:] in w["title"].lower()]
    else:
        stem = lambda w: w["exe"].lower()[:-4] if w["exe"].lower().endswith(".exe") else w["exe"].lower()
        cands = [w for w in wins if stem(w) == low or w["exe"].lower() == low]
        if not cands:
            cands = [w for w in wins if low in w["title"].lower()]
        if not cands:
            cands = [w for w in wins if low in stem(w)]
    if not cands:
        raise StepError("no visible window matches %r; run `windows` to list them" % spec)
    pids = {w["pid"] for w in cands}
    if len(pids) > 1:
        listed = "; ".join("hwnd:%d %s %r" % (w["hwnd"], w["exe"], w["title"][:60]) for w in cands[:12])
        raise StepError("%r matches windows of %d processes; name one by hwnd: %s" % (spec, len(pids), listed))
    # TODO(review): Refuse multiple matching HWNDs or explicitly document largest-window selection.
    # One process: its largest window is the game surface (launchers and
    # splash windows of the same process are smaller).
    return max(cands, key=lambda w: (not w["minimized"], w["width"] * w["height"]))


def foreground():
    h = user32.GetForegroundWindow()
    return describe(h) if h else None


def focus(win):
    h = win["hwnd"]
    if not user32.IsWindow(h) or window_pid(h) != win["pid"]:
        raise StepError("the target window no longer belongs to the selected process")
    if user32.IsIconic(h):
        user32.ShowWindow(h, 9)  # SW_RESTORE
    for attempt in range(3):
        fg = user32.GetForegroundWindow()
        if fg and window_pid(fg) == win["pid"]:
            return True
        if attempt == 0:
            user32.SetForegroundWindow(h)
        elif attempt == 1:
            me = kernel32.GetCurrentThreadId()
            other = user32.GetWindowThreadProcessId(fg, None) if fg else 0
            # TODO(review): Attachment shares and resets key state; choose a focus policy that avoids it.
            attached = other and other != me and user32.AttachThreadInput(me, other, True)
            try:
                user32.BringWindowToTop(h)
                user32.SetForegroundWindow(h)
            finally:
                if attached:
                    user32.AttachThreadInput(me, other, False)
        time.sleep(0.12)
    fg = user32.GetForegroundWindow()
    return bool(fg) and window_pid(fg) == win["pid"]


# ── frames ────────────────────────────────────────────────────────────────────
def scale_for(width, height, max_dim):
    big = max(width, height)
    return 1.0 if not max_dim or big <= max_dim else big / float(max_dim)


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG), ("biPlanes", W.WORD),
                ("biBitCount", W.WORD), ("biCompression", W.DWORD), ("biSizeImage", W.DWORD),
                ("biXPelsPerMeter", W.LONG), ("biYPelsPerMeter", W.LONG), ("biClrUsed", W.DWORD),
                ("biClrImportant", W.DWORD)]


gdi32 = ctypes.WinDLL("gdi32")
user32.GetDC.argtypes = [W.HWND]
user32.GetDC.restype = W.HDC
user32.ReleaseDC.argtypes = [W.HWND, W.HDC]
gdi32.CreateCompatibleDC.argtypes = [W.HDC]
gdi32.CreateCompatibleDC.restype = W.HDC
gdi32.CreateCompatibleBitmap.argtypes = [W.HDC, ctypes.c_int, ctypes.c_int]
gdi32.CreateCompatibleBitmap.restype = W.HBITMAP
gdi32.SelectObject.argtypes = [W.HDC, W.HGDIOBJ]
gdi32.SelectObject.restype = W.HGDIOBJ
gdi32.BitBlt.argtypes = [W.HDC] + [ctypes.c_int] * 4 + [W.HDC, ctypes.c_int, ctypes.c_int, W.DWORD]
gdi32.GetDIBits.argtypes = [W.HDC, W.HBITMAP, W.UINT, W.UINT, ctypes.c_void_p, ctypes.c_void_p, W.UINT]
gdi32.GetPixel.argtypes = [W.HDC, ctypes.c_int, ctypes.c_int]
gdi32.GetPixel.restype = W.DWORD
gdi32.DeleteObject.argtypes = [W.HGDIOBJ]
gdi32.DeleteDC.argtypes = [W.HDC]


def grab(rect):
    """Copy one screen rectangle (physical pixels) off the composed desktop.
    Only the rectangle is copied, so a small region costs little."""
    from PIL import Image
    x, y, w, h = rect
    hdc = user32.GetDC(None)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
    old = gdi32.SelectObject(mdc, bmp)
    try:
        if not gdi32.BitBlt(mdc, 0, 0, w, h, hdc, x, y, 0x00CC0020):  # SRCCOPY
            raise StepError("screen copy failed; is the desktop locked?")
        gdi32.SelectObject(mdc, old)  # GetDIBits requires an unselected bitmap.
        bi = BITMAPINFOHEADER(ctypes.sizeof(BITMAPINFOHEADER), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        if gdi32.GetDIBits(mdc, bmp, 0, h, buf, ctypes.byref(bi), 0) != h:
            raise StepError("screen copy returned no pixels")
        return Image.frombuffer("RGB", (w, h), buf, "raw", "BGRX", 0, 1)
    finally:
        gdi32.SelectObject(mdc, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mdc)
        user32.ReleaseDC(None, hdc)


def pixel(x, y):
    hdc = user32.GetDC(None)
    try:
        c = gdi32.GetPixel(hdc, x, y)
    finally:
        user32.ReleaseDC(None, hdc)
    if c == 0xFFFFFFFF:
        raise StepError("pixel %d,%d is off screen" % (x, y))
    return (c & 0xFF, (c >> 8) & 0xFF, (c >> 16) & 0xFF)


def frame_of(win, max_dim, quality):
    if win:
        if win["minimized"]:
            raise StepError("the target window is minimized; focus it first")
        rect = (win["x"], win["y"], win["width"], win["height"])
    else:
        sw, sh = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
        rect = (0, 0, sw, sh)
    t0 = time.perf_counter()
    img = grab(rect)
    s = scale_for(img.width, img.height, max_dim)
    if s != 1.0:
        from PIL import Image
        img = img.resize((max(1, round(img.width / s)), max(1, round(img.height / s))), Image.BILINEAR)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality)
    lo = img.getextrema()
    black = all(hi <= 8 for _, hi in lo)
    return {"jpeg": base64.b64encode(buf.getvalue()).decode("ascii"), "width": img.width, "height": img.height,
            "client": [rect[2], rect[3]], "scale": round(s, 6), "ms": round((time.perf_counter() - t0) * 1000),
            "black": black}


# ── input state ───────────────────────────────────────────────────────────────
class Inputs:
    def __init__(self):
        self.lock = threading.RLock()
        self.desktop_target = None
        self.unicode = set()   # UTF-16 units whose key-up may need retry
        self.keys = set()      # keyboard keys held
        self.mouse = set()     # mouse buttons held
        self.pad_buttons = set()
        self.triggers = {"lt": 0.0, "rt": 0.0}
        self.sticks = {"left": (0.0, 0.0), "right": (0.0, 0.0)}
        self.pad = None
        self.vg = None
        self.lease_until = 0.0

    def gamepad(self):
        if self.pad is None:
            try:
                import vgamepad
            except Exception as e:
                raise StepError("vgamepad is unavailable (%s); rerun `fleet game <host> start`" % e)
            try:
                self.pad = vgamepad.VX360Gamepad()
            except Exception as e:
                raise StepError("could not plug in a virtual Xbox pad (%s); is ViGEmBus installed?" % e)
            self.vg = vgamepad
            log("virtual pad connected")
        return self.pad

    def held(self):
        out = ["unicode:%04x" % c for c in sorted(self.unicode)] + sorted(self.keys) + sorted(self.mouse) + ["pad." + b for b in sorted(self.pad_buttons)]
        out += ["pad.%s=%.2f" % (t, v) for t, v in sorted(self.triggers.items()) if v]
        out += ["stick.%s=%.2f,%.2f" % (s, x, y) for s, (x, y) in sorted(self.sticks.items()) if x or y]
        return out

    def press(self, kind, name, up):
        with self.lock:
            if kind == "key":
                send(key_input(name, up))
                (self.keys.discard if up else self.keys.add)(name)
            elif kind == "mouse":
                d, u, data = MOUSE[name]
                send(mouse_input(u if up else d, data=data))
                (self.mouse.discard if up else self.mouse.add)(name)
            elif kind == "pad":
                pad = self.gamepad()
                button = getattr(self.vg.XUSB_BUTTON, PAD_BUTTONS[name])
                (pad.release_button if up else pad.press_button)(button=button)
                if not up:
                    self.pad_buttons.add(name)  # Retain state if update partially fails.
                pad.update()
                if up:
                    self.pad_buttons.discard(name)
            elif kind == "trigger":
                self.trigger(name, 0.0 if up else 1.0)

    def trigger(self, name, value):
        with self.lock:
            pad = self.gamepad()
            (pad.left_trigger_float if name == "lt" else pad.right_trigger_float)(value_float=value)
            self.triggers[name] = value or self.triggers[name]
            pad.update()
            self.triggers[name] = value

    def stick(self, side, x, y):
        with self.lock:
            pad = self.gamepad()
            (pad.left_joystick_float if side == "left" else pad.right_joystick_float)(x_value_float=x, y_value_float=y)
            if x or y:
                self.sticks[side] = (x, y)
            pad.update()
            self.sticks[side] = (x, y)

    def release_all(self):
        """Release everything held. Never raises: it runs on error paths."""
        with self.lock:
            for code in list(self.unicode):
                i = INPUT(type=1)
                i.u.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
                try:
                    send(i)
                    self.unicode.discard(code)
                except Exception:
                    pass
            for k in list(self.keys):
                try:
                    send(key_input(k, True))
                    self.keys.discard(k)
                except Exception:
                    pass
            for m in list(self.mouse):
                try:
                    send(mouse_input(MOUSE[m][1], data=MOUSE[m][2]))
                    self.mouse.discard(m)
                except Exception:
                    pass
            if self.pad is not None:
                try:
                    self.pad.reset(); self.pad.update()
                    self.pad_buttons.clear()
                    self.triggers = {"lt": 0.0, "rt": 0.0}
                    self.sticks = {"left": (0.0, 0.0), "right": (0.0, 0.0)}
                except Exception:
                    pass
            self.lease_until = time.time() + 0.1 if self.held() else 0.0

    def unplug(self):
        with self.lock:
            self.release_all()
            if self.pad is not None:
                self.pad = None
                self.pad_buttons.clear()
                self.triggers = {"lt": 0.0, "rt": 0.0}
                self.sticks = {"left": (0.0, 0.0), "right": (0.0, 0.0)}
                log("virtual pad disconnected")


INPUTS = Inputs()


# ── runs ──────────────────────────────────────────────────────────────────────
class Run:
    def __init__(self, steps, target, repeat, max_dim, quality, detached, connected=None):
        self.id = secrets.token_hex(3)
        self.steps, self.target, self.repeat = steps, target, repeat
        self.max_dim, self.quality, self.detached = max_dim, quality, detached
        self.connected = connected
        self.abort = threading.Event()
        self.state, self.error, self.loop, self.done_steps = "running", None, 0, 0
        self.started = time.time()
        self.ended = None
        self.frames = []
        self.notes = []

    def summary(self):
        s = {"id": self.id, "state": self.state, "loop": self.loop, "repeat": self.repeat,
             "steps": self.done_steps, "seconds": round((self.ended or time.time()) - self.started, 2),
             "detached": self.detached}
        if self.target:
            s["target"] = {k: self.target[k] for k in ("hwnd", "pid", "exe", "title")}
        if self.error:
            s["error"] = self.error
        return s

    # -- timing
    def sleep(self, ms):
        end = time.perf_counter() + ms / 1000.0
        while True:
            self.check()
            left = end - time.perf_counter()
            if left <= 0:
                return
            if self.abort.wait(min(left, 0.05)):
                raise Aborted("halted")

    def check(self):
        if self.abort.is_set():
            raise Aborted("halted")
        if self.connected and not self.connected():
            raise Aborted("the synchronous client disconnected")
        if self.target and (INPUTS.keys or INPUTS.mouse):
            self.guard()

    def guard(self):
        """Refuse desktop input when the selected process loses foreground."""
        # TODO(review): Win32 cannot atomically bind SendInput to this foreground check.
        if not self.target:
            raise StepError("keyboard and mouse steps need a target window")
        if not user32.IsWindow(self.target["hwnd"]) or window_pid(self.target["hwnd"]) != self.target["pid"]:
            raise Aborted("the target window was destroyed or replaced")
        fg = user32.GetForegroundWindow()
        if not fg or window_pid(fg) != self.target["pid"]:
            now = describe(fg) if fg else None
            raise Aborted("the target lost the foreground to %s; cleanup attempted for all held inputs"
                          % ("%s %r" % (now["exe"], now["title"][:60]) if now else "nothing"))

    def point(self, at):
        if not self.target:
            raise StepError("`at` needs a target window")
        win = describe(self.target["hwnd"])
        s = scale_for(win["width"], win["height"], self.max_dim)
        cx, cy = round(at[0] * s), round(at[1] * s)
        if not (0 <= cx < win["width"] and 0 <= cy < win["height"]):
            raise StepError("point %s is outside the target (frame %dx%d)" % (
                at, round(win["width"] / s), round(win["height"] / s)))
        return win["x"] + cx, win["y"] + cy

    def event(self, fn, desktop=False):
        with INPUTS.lock:
            self.check()
            if desktop:
                self.guard()
            return fn()

    def cursor_guard(self):
        p = W.POINT()
        if not user32.GetCursorPos(ctypes.byref(p)):
            raise StepError("could not read the cursor position")
        win = describe(self.target["hwnd"])
        if not (win["x"] <= p.x < win["x"] + win["width"] and
                win["y"] <= p.y < win["y"] + win["height"]):
            raise StepError("cursor is outside the target client area")
        h = user32.WindowFromPoint(p)
        if not h or window_pid(h) != self.target["pid"]:
            raise Aborted("another process covers the target at the cursor")

    def move_to(self, at):
        x, y = self.point(at)
        if not user32.SetCursorPos(x, y):
            raise StepError("could not move the cursor")

    def press_many(self, names, up):
        parsed = [norm_key(n) for n in names]
        for kind, name in (reversed(parsed) if up else parsed):
            def press():
                if kind in ("key", "mouse") and not up:
                    INPUTS.desktop_target = self.target
                if kind == "mouse" and not up:
                    self.cursor_guard()
                INPUTS.press(kind, name, up)
            self.event(press, kind in ("key", "mouse"))

    # -- steps
    def exec_steps(self, steps, depth=0):
        for step in steps:
            self.check()
            self.exec_step(step, depth)
            self.done_steps += 1

    def exec_step(self, st, depth):
        if not isinstance(st, dict):
            raise StepError("each step must be an object")
        keys = lambda v: v if isinstance(v, list) else [v]
        ms = st.get("ms")
        if "tap" in st:
            names = keys(st["tap"])
            self.press_many(names, False)
            try:
                self.sleep(40 if ms is None else ms)
            finally:
                if not self.abort.is_set():
                    self.press_many(names, True)
        elif "hold" in st:
            names = keys(st["hold"])
            self.press_many(names, False)
            try:
                self.sleep(ms or 0)
            finally:
                if not self.abort.is_set():
                    self.press_many(names, True)
        elif "down" in st:
            self.press_many(keys(st["down"]), False)
        elif "up" in st:
            self.press_many(keys(st["up"]), True)
        elif "type" in st:
            for ch in str(st["type"]):
                units = ch.encode("utf-16-le")
                for i in range(0, len(units), 2):
                    code = int.from_bytes(units[i:i + 2], "little")
                    a, b = INPUT(type=1), INPUT(type=1)
                    a.u.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE, 0, 0)
                    b.u.ki = KEYBDINPUT(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
                    def type_unit():
                        INPUTS.desktop_target = self.target
                        INPUTS.unicode.add(code)
                        send(a, b)
                        INPUTS.unicode.discard(code)
                    self.event(type_unit, True)
                self.sleep(st.get("gap", 12))
        elif "look" in st:
            dx, dy = st["look"]
            total = ms or 0
            ticks = max(1, int(total // 8))
            sent_x = sent_y = 0
            t0 = time.perf_counter()
            for i in range(1, ticks + 1):
                tx, ty = round(dx * i / ticks), round(dy * i / ticks)
                self.event(lambda: send(mouse_input(MOUSEEVENTF_MOVE, tx - sent_x, ty - sent_y)), True)
                sent_x, sent_y = tx, ty
                if i < ticks:
                    self.sleep(max(0.0, (t0 + total / 1000.0 * i / ticks - time.perf_counter()) * 1000))
        elif "move" in st:
            self.event(lambda: self.move_to(st["move"]), True)
        elif "click" in st:
            name = st["click"].lower() if isinstance(st["click"], str) else "left"
            button = MOUSE_ALIAS.get(name, name)
            if button not in MOUSE:
                raise StepError("unknown mouse button %r" % st["click"])
            if "at" in st:
                self.event(lambda: self.move_to(st["at"]), True)
                self.sleep(16)
            for i in range(int(st.get("count", 1))):
                self.press_many([button], False)
                self.sleep(30 if ms is None else ms)
                self.press_many([button], True)
                if i + 1 < int(st.get("count", 1)):
                    self.sleep(60)
        elif "wheel" in st:
            def wheel():
                self.cursor_guard()
                send(mouse_input(MOUSEEVENTF_WHEEL, data=int(st["wheel"]) * 120))
            self.event(wheel, True)
        elif "stick" in st:
            side = st["stick"]
            x, y = st["xy"]
            self.event(lambda: INPUTS.stick(side, float(x), float(y)))
            if ms:
                self.sleep(ms)
                self.event(lambda: INPUTS.stick(side, 0.0, 0.0))
        elif "trigger" in st:
            name = PAD_ALIAS.get(st["trigger"].lower(), st["trigger"].lower())
            self.event(lambda: INPUTS.trigger(name, float(st.get("value", 1.0))))
            if ms:
                self.sleep(ms)
                self.event(lambda: INPUTS.trigger(name, 0.0))
        elif "wait" in st:
            self.sleep(st["wait"])
        elif "wait_pixel" in st:
            self.wait_pixel(st)
        elif "shot" in st:
            if self.detached:
                return
            win = describe(self.target["hwnd"]) if self.target else None
            self.frames.append(frame_of(win, self.max_dim, self.quality))
        elif "repeat" in st:
            if depth >= 4:
                raise StepError("repeat nests at most 4 deep")
            for _ in range(int(st["repeat"])):
                self.exec_steps(st["steps"], depth + 1)
        elif "focus" in st:
            if not self.target or not self.event(lambda: focus(self.target)):
                raise StepError("could not bring the target to the foreground")
        else:
            raise StepError("unknown step %s" % json.dumps(st)[:120])

    def wait_pixel(self, st):
        if not self.target:
            raise StepError("wait_pixel needs a target window")
        want, tol = st["rgb"], int(st.get("tol", 24))
        gone = bool(st.get("gone"))
        deadline = time.perf_counter() + st["timeout"] / 1000.0
        last = None
        while True:
            self.check()
            self.guard()
            x, y = self.point(st["wait_pixel"])
            px = pixel(x, y)
            last = px
            match = all(abs(px[i] - want[i]) <= tol for i in range(3))
            if match != gone:
                return
            if time.perf_counter() >= deadline:
                raise StepError("wait_pixel %s timed out: pixel is %s, wanted %s%s" % (
                    st["wait_pixel"], list(last), "not " if gone else "", want))
            self.sleep(st.get("every", 50))

    def run(self):
        try:
            self.check()
            if self.target and needs_focus(self.steps):
                if not self.event(lambda: focus(self.target)):
                    raise StepError("could not bring %s %r to the foreground" % (
                        self.target["exe"], self.target["title"][:60]))
            loops = self.repeat
            while loops == 0 or self.loop < loops:
                self.exec_steps(self.steps)
                self.loop += 1
            self.state = "done"
        except Aborted as e:
            self.state, self.error = ("halted" if str(e) == "halted" else "aborted"), str(e)
            INPUTS.release_all()
        except StepError as e:
            self.state, self.error = "failed", str(e)
            INPUTS.release_all()
        except Exception as e:
            self.state, self.error = "failed", "%s: %s" % (type(e).__name__, e)
            log(traceback.format_exc())
            INPUTS.release_all()
        finally:
            self.ended = time.time()
            with INPUTS.lock:
                if self.detached or self.abort.is_set() or self.state != "done":
                    INPUTS.release_all()
                else:
                    INPUTS.lease_until = time.time() + LEASE_S if INPUTS.held() else 0.0


def needs_focus(steps):
    needed = False
    for st in steps:
        if not isinstance(st, dict):
            raise StepError("each step must be an object")
        if "repeat" in st:
            nested = needs_focus(st.get("steps") or [])
            needed = needed or nested
        for k in ("tap", "hold", "down", "up"):
            if k in st:
                names = st[k] if isinstance(st[k], list) else [st[k]]
                for name in names:
                    kind, _ = norm_key(name)
                    needed = needed or kind in ("key", "mouse")
        if any(k in st for k in ("type", "look", "move", "click", "wheel", "wait_pixel", "focus")):
            needed = True
    return needed


LEASE_S = 10.0
RUN_LOCK = threading.Lock()
CURRENT = {"run": None, "last": None, "stopping": False}


def lease_watch():
    while True:
        time.sleep(0.1)
        with INPUTS.lock:
            owner = INPUTS.desktop_target
            fg = user32.GetForegroundWindow() if owner and (INPUTS.keys or INPUTS.mouse or INPUTS.unicode) else None
            lost = owner and (INPUTS.keys or INPUTS.mouse or INPUTS.unicode) and (not fg or window_pid(fg) != owner["pid"])
            if CURRENT["run"] is None and (lost or (INPUTS.lease_until and time.time() > INPUTS.lease_until)):
                log("focus lost or lease expired; releasing %s" % ", ".join(INPUTS.held()))
                INPUTS.release_all()


# ── requests ──────────────────────────────────────────────────────────────────
def status():
    with INPUTS.lock:
        return status_locked()


def status_locked():
    run = CURRENT["run"] or CURRENT["last"]
    return {"ok": True, "version": VERSION, "pid": os.getpid(), "foreground": foreground(),
            "held": INPUTS.held(), "pad": INPUTS.pad is not None,
            "lease_s": round(max(0.0, INPUTS.lease_until - time.time()), 1) if INPUTS.lease_until else 0,
            "run": run.summary() if run else None}


def handle(req, connected=None):
    op = req.get("op")
    if op == "status":
        return status()
    if op == "windows":
        f = (req.get("filter") or "").lower()
        wins = [w for w in top_windows() if not f or f in w["title"].lower() or f in w["exe"].lower()]
        fg = user32.GetForegroundWindow()
        for w in wins:
            w["foreground"] = bool(fg) and w["hwnd"] == int(fg)
        return {"ok": True, "windows": wins}
    if op == "focus":
        win = resolve_target(req["target"])
        with INPUTS.lock:
            if CURRENT["run"] or CURRENT["stopping"]:
                raise StepError("busy: cannot focus during a run or shutdown")
            owner = INPUTS.desktop_target
            if owner and owner["pid"] != win["pid"] and (INPUTS.keys or INPUTS.mouse or INPUTS.unicode):
                INPUTS.release_all()
                if INPUTS.held():
                    raise StepError("could not release inputs before switching targets")
            ok = focus(win)
        return {"ok": ok, "target": win, "foreground": foreground(),
                **({} if ok else {"error": "Windows refused to bring the target to the foreground"})}
    if op == "frame":
        win = resolve_target(req["target"]) if req.get("target") else None
        f = frame_of(win, int(req.get("max", 1280)), int(req.get("quality", 80)))
        return {"ok": True, "target": win, "frame": f}
    if op == "release":
        with INPUTS.lock:
            run = CURRENT["run"]
            if run:
                run.abort.set()
            held = INPUTS.held()
            INPUTS.release_all()
            if req.get("unplug"):
                INPUTS.unplug()
            remaining = INPUTS.held()
            return {"ok": not remaining, "released": held, "halted": run.id if run else None,
                    **({"error": "some inputs could not be released; cleanup will retry"} if remaining else {})}
    if op == "do":
        steps = req.get("steps")
        if not isinstance(steps, list) or not steps:
            raise StepError("steps must be a non-empty array")
        target = resolve_target(req["target"]) if req.get("target") else None
        if needs_focus(steps) and not target:
            raise StepError("keyboard, mouse and pixel steps need a target window")
        repeat = int(req.get("repeat", 1))
        detach = bool(req.get("detach"))
        if repeat == 0 and not detach:
            raise StepError("repeat 0 (forever) needs detach")
        run = Run(steps, target, repeat, int(req.get("max", 1280)), int(req.get("quality", 80)),
                  detach, None if detach else connected)
        with INPUTS.lock:
            if CURRENT["stopping"]:
                raise StepError("the helper is stopping")
            if not RUN_LOCK.acquire(blocking=False):
                r = CURRENT["run"]
                raise StepError("busy: run %s is %s; halt it with `release`" % (r.id if r else "?", r.state if r else "?"))
            owner = INPUTS.desktop_target
            if owner and (not target or owner["pid"] != target["pid"]) and (INPUTS.keys or INPUTS.mouse or INPUTS.unicode):
                INPUTS.release_all()
                if INPUTS.held():
                    RUN_LOCK.release()
                    raise StepError("could not release inputs before switching targets")
            CURRENT["run"] = run
            INPUTS.lease_until = 0.0

        def go():
            try:
                run.run()
                with INPUTS.lock:
                    return {"ok": run.state == "done", "run": run.summary(), "frames": run.frames,
                            "held": INPUTS.held(), "lease_s": max(0, INPUTS.lease_until - time.time()),
                            "foreground": foreground(), **({"error": run.error} if run.error else {})}
            finally:
                with INPUTS.lock:
                    CURRENT["last"], CURRENT["run"] = run, None
                    RUN_LOCK.release()
                log("run %s %s after %d loop(s): %s" % (run.id, run.state, run.loop, run.error or "ok"))

        if detach:
            with INPUTS.lock:
                try:
                    threading.Thread(target=go, daemon=True).start()
                except Exception:
                    CURRENT["run"] = None
                    INPUTS.release_all()
                    RUN_LOCK.release()
                    raise
                return {"ok": True, "run": run.summary()}
        return go()
    if op == "stop":
        with INPUTS.lock:
            CURRENT["stopping"] = True
            run = CURRENT["run"]
            if run:
                run.abort.set()
            INPUTS.unplug()
            if INPUTS.held():
                return {"ok": False, "error": "some inputs could not be released; cleanup will retry before stop"}
        threading.Thread(target=lambda: (time.sleep(0.2), SERVER.shutdown()), daemon=True).start()
        return {"ok": True, "stopped": os.getpid()}
    raise StepError("unknown op %r" % op)


class Handler(socketserver.StreamRequestHandler):
    def connected(self):
        try:
            ready, _, _ = select.select([self.connection], [], [], 0)
            return not ready or bool(self.connection.recv(1, socket.MSG_PEEK))
        except OSError:
            return False

    def handle(self):
        try:
            line = self.rfile.readline(4 * 1024 * 1024)
            req = json.loads(line.decode("utf-8"))
            if not isinstance(req, dict) or not secrets.compare_digest(str(req.get("token", "")), TOKEN):
                reply = {"ok": False, "error": "bad token"}
            else:
                try:
                    reply = handle(req, self.connected)
                except (StepError, Aborted) as e:
                    reply = {"ok": False, "error": str(e)}
                except Exception as e:
                    log(traceback.format_exc())
                    reply = {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
            reply["version"] = VERSION
        except Exception as e:
            reply = {"ok": False, "error": "bad request: %s" % e, "version": VERSION}
        self.wfile.write((json.dumps(reply) + "\n").encode("utf-8"))


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False


def main():
    global TOKEN, SERVER
    kernel32.CreateMutexW(None, False, "Local\\fleet-game-helper")
    if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
        log("another helper is running; exiting")
        return
    # A manifest may already have selected per-monitor v2; otherwise require it.
    if not user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)) and not user32.AreDpiAwarenessContextsEqual(
            user32.GetThreadDpiAwarenessContext(), ctypes.c_void_p(-4)):
        log("could not establish per-monitor v2 DPI awareness; refusing ambiguous coordinates")
        raise StepError("could not establish per-monitor v2 DPI awareness")
    winmm.timeBeginPeriod(1)
    try:
        if os.path.getsize(LOG) > 1 << 20:
            os.replace(LOG, LOG + ".1")
    except OSError:
        pass
    TOKEN = secrets.token_hex(16)
    SERVER = Server(("127.0.0.1", 0), Handler)
    port = SERVER.server_address[1]
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"pid": os.getpid(), "port": port, "token": TOKEN, "version": VERSION,
                   "started": int(time.time())}, f)
    os.replace(tmp, STATE)
    log("helper %s listening on 127.0.0.1:%d (pid %d)" % (VERSION, port, os.getpid()))
    threading.Thread(target=lease_watch, daemon=True).start()
    try:
        SERVER.serve_forever(poll_interval=0.2)
    finally:
        with INPUTS.lock:
            CURRENT["stopping"] = True
            if CURRENT["run"]:
                CURRENT["run"].abort.set()
            INPUTS.unplug()
        SERVER.server_close()
        try:
            with open(STATE, encoding="utf-8") as f:
                if json.load(f).get("pid") == os.getpid():
                    os.remove(STATE)
        except (OSError, ValueError):
            pass
        log("helper %s stopped" % VERSION)


if __name__ == "__main__":
    main()
