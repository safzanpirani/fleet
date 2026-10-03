"""Exercise the real helper with mocked Win32 APIs; never send desktop input."""
import ctypes
import importlib.util
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

libraries = {}

def library(name, **kwargs):
    libraries.setdefault(name, MagicMock())
    return libraries[name]

spec = importlib.util.spec_from_file_location("game_helper", Path(__file__).parent.parent / "src/game-helper.py")
g = importlib.util.module_from_spec(spec)
with patch.object(ctypes, "WinDLL", library, create=True), patch.object(ctypes, "WINFUNCTYPE", ctypes.CFUNCTYPE, create=True):
    spec.loader.exec_module(g)

ORIGINAL_FOCUS = g.focus

TARGET = {"hwnd": 10, "pid": 100, "exe": "game.exe", "title": "Game", "x": -1920, "y": 0,
          "width": 1920, "height": 1080, "minimized": False}

class SafetyTests(unittest.TestCase):
    def setUp(self):
        g.INPUTS = g.Inputs()
        g.RUN_LOCK = threading.Lock()
        g.CURRENT = {"run": None, "last": None, "stopping": False}
        self.fg = 10
        self.events = []
        for lib in libraries.values():
            lib.reset_mock(return_value=True, side_effect=True)
        g.user32.IsWindow.return_value = True
        g.user32.IsIconic.return_value = False
        g.user32.GetForegroundWindow.side_effect = lambda: self.fg
        g.user32.GetCursorPos.side_effect = self.cursor
        g.user32.WindowFromPoint.return_value = 10
        g.user32.SetCursorPos.return_value = True
        g.user32.SendInput.side_effect = self.send
        self.patches = [patch.object(g, "window_pid", lambda h: 100 if h == 10 else 200),
                        patch.object(g, "describe", lambda h: dict(TARGET) if h == 10 else {**TARGET, "pid": 200}),
                        patch.object(g, "resolve_target", lambda _: dict(TARGET)),
                        patch.object(g, "log", lambda _: None),
                        patch.object(g, "focus", lambda _: True)]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def cursor(self, ptr):
        ptr._obj.x, ptr._obj.y = -1900, 20
        return 1

    def send(self, count, arr, size):
        self.events.extend((arr[i].type, arr[i].u.ki.wScan if arr[i].type == 1 else arr[i].u.mi.dwFlags,
                            arr[i].u.ki.dwFlags if arr[i].type == 1 else 0) for i in range(count))
        return count

    def run_steps(self, steps, **kw):
        r = g.Run(steps, dict(TARGET), 1, 1280, 80, False, **kw)
        r.run()
        return r

    def test_typing_stops_before_next_character_when_focus_changes(self):
        def send(count, arr, size):
            result = self.send(count, arr, size)
            self.fg = 20
            return result
        g.user32.SendInput.side_effect = send
        r = self.run_steps([{"type": "abc", "gap": 0}])
        self.assertEqual(r.state, "aborted")
        self.assertEqual(len(self.events), 2)
        self.assertFalse(g.INPUTS.held())

    def test_chord_rechecks_foreground_between_keys(self):
        def send(count, arr, size):
            result = self.send(count, arr, size)
            self.fg = 20
            return result
        g.user32.SendInput.side_effect = send
        r = self.run_steps([{"tap": ["ctrl", "w"]}])
        self.assertEqual(r.state, "aborted")
        self.assertEqual([e[1] for e in self.events], [g.SCAN["lctrl"][0]] * 2)
        self.assertFalse(g.INPUTS.held())

    def test_look_and_repeated_clicks_stop_on_focus_loss(self):
        for st in ({"look": [100, 0], "ms": 32}, {"click": "left", "count": 3, "ms": 0}):
            with self.subTest(step=st):
                self.fg = 10
                self.events.clear()
                def send(count, arr, size):
                    result = self.send(count, arr, size)
                    self.fg = 20
                    return result
                g.user32.SendInput.side_effect = send
                r = self.run_steps([st])
                self.assertEqual(r.state, "aborted")
                self.assertLessEqual(len(self.events), 2)
                self.assertFalse(g.INPUTS.held())

    def test_click_refuses_other_process_under_cursor(self):
        g.user32.WindowFromPoint.return_value = 20
        r = self.run_steps([{"click": "left"}])
        self.assertEqual(r.state, "aborted")
        self.assertFalse(self.events)

    def test_points_map_negative_monitor_and_refuse_bounds(self):
        r = g.Run([], dict(TARGET), 1, 1280, 80, False)
        self.assertEqual(r.point([100, 100]), (-1770, 150))
        with self.assertRaises(g.StepError):
            r.point([1280, 0])

    def test_validates_later_and_nested_key_names_before_focus(self):
        for steps in ([{"tap": "w"}, {"tap": "bad-key"}],
                      [{"look": [1, 1]}, {"repeat": 1, "steps": [{"down": "bad-key"}]}],
                      [{"tap": ["w", "bad-key"]}]):
            with patch.object(g, "focus") as focus:
                with self.assertRaises(g.StepError):
                    g.handle({"op": "do", "target": "game", "steps": steps})
                focus.assert_not_called()
        self.assertFalse(self.events)

    def test_release_fences_an_event_waiting_for_lock(self):
        r = g.Run([], dict(TARGET), 1, 1280, 80, False)
        g.CURRENT["run"] = r
        ready = threading.Event()
        errors = []
        def press():
            ready.set()
            try:
                r.press_many(["w"], False)
            except g.Aborted:
                errors.append("aborted")
        with g.INPUTS.lock:
            t = threading.Thread(target=press)
            t.start()
            self.assertTrue(ready.wait(1))
            g.handle({"op": "release"})
        t.join(1)
        self.assertFalse(t.is_alive())
        self.assertEqual(errors, ["aborted"])
        self.assertFalse(self.events)

    def test_sync_disconnect_releases_held_input_during_wait(self):
        client, server = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(server.close)
        h = g.Handler.__new__(g.Handler)
        h.connection = server
        def send(count, arr, size):
            result = self.send(count, arr, size)
            client.close()
            return result
        g.user32.SendInput.side_effect = send
        result = g.handle({"op": "do", "target": "game", "steps": [{"down": "w"}, {"wait": 10000}]}, h.connected)
        self.assertEqual(result["run"]["state"], "aborted")
        self.assertIn("disconnected", result["error"])
        self.assertFalse(g.INPUTS.held())
        self.assertFalse(g.RUN_LOCK.locked())

    def test_failed_release_keeps_state_and_retries(self):
        g.INPUTS.keys.add("w")
        with patch.object(g, "send", side_effect=g.StepError("blocked")):
            result = g.handle({"op": "release"})
        self.assertFalse(result["ok"])
        self.assertEqual(g.INPUTS.held(), ["w"])
        self.assertGreater(g.INPUTS.lease_until, time.time())
        g.INPUTS.release_all()
        self.assertFalse(g.INPUTS.held())

    def test_partial_unicode_pair_is_released_on_error(self):
        def send(count, arr, size):
            self.send(count, arr, size)
            return 1 if count == 2 else count
        g.user32.SendInput.side_effect = send
        with patch.object(ctypes, "get_last_error", lambda: 0, create=True):
            r = self.run_steps([{"type": "a"}])
        self.assertEqual(r.state, "failed")
        self.assertEqual(self.events[-1][2], g.KEYEVENTF_UNICODE | g.KEYEVENTF_KEYUP)
        self.assertFalse(g.INPUTS.held())

    def test_two_runs_refuse_overlap_and_release_unblocks_first(self):
        entered = threading.Event()
        original = g.Run.sleep
        result = []
        def sleep(run, ms):
            entered.set()
            return original(run, ms)
        with patch.object(g.Run, "sleep", sleep):
            t = threading.Thread(target=lambda: result.append(g.handle({"op": "do", "steps": [{"wait": 10000}]})))
            t.start()
            try:
                self.assertTrue(entered.wait(1))
                with self.assertRaisesRegex(g.StepError, "busy"):
                    g.handle({"op": "do", "steps": [{"wait": 0}]})
            finally:
                g.handle({"op": "release"})
                t.join(1)
        self.assertFalse(t.is_alive())
        self.assertEqual(result[0]["run"]["state"], "halted")
        self.assertFalse(g.RUN_LOCK.locked())

    def test_invalid_run_options_do_not_leak_run_lock(self):
        with self.assertRaises(ValueError):
            g.handle({"op": "do", "steps": [{"wait": 0}], "max": "bad"})
        self.assertTrue(g.handle({"op": "do", "steps": [{"wait": 0}]})["ok"])

    def test_stop_fences_future_runs(self):
        with patch.object(g, "SERVER", MagicMock(), create=True), patch.object(g.threading, "Thread"):
            g.handle({"op": "stop"})
        with self.assertRaisesRegex(g.StepError, "stopping"):
            g.handle({"op": "do", "steps": [{"wait": 0}]})

    def test_detached_thread_start_failure_releases_lock(self):
        with patch.object(g.threading, "Thread") as thread:
            thread.return_value.start.side_effect = RuntimeError("no thread")
            with self.assertRaises(RuntimeError):
                g.handle({"op": "do", "steps": [{"wait": 0}], "detach": True})
        self.assertFalse(g.RUN_LOCK.locked())
        self.assertIsNone(g.CURRENT["run"])

    def test_release_before_run_starts_prevents_focus_and_input(self):
        ready, proceed = threading.Event(), threading.Event()
        original = g.Run.run
        results = []
        def run(r):
            ready.set()
            if not proceed.wait(1):
                raise RuntimeError("test did not resume run")
            original(r)
        with patch.object(g.Run, "run", run), patch.object(g, "focus") as focus:
            t = threading.Thread(target=lambda: results.append(g.handle({"op": "do", "target": "game", "steps": [{"tap": "w"}]})))
            t.start()
            try:
                self.assertTrue(ready.wait(1))
                g.handle({"op": "release"})
            finally:
                proceed.set()
                t.join(1)
            focus.assert_not_called()
        self.assertFalse(t.is_alive())
        self.assertEqual(results[0]["run"]["state"], "halted")
        self.assertFalse(self.events)

    def test_focus_does_not_send_mouse_and_detaches_on_exception(self):
        self.fg = 20
        g.kernel32.GetCurrentThreadId.return_value = 1
        g.user32.GetWindowThreadProcessId.return_value = 2
        g.user32.AttachThreadInput.return_value = 1
        g.user32.SetForegroundWindow.side_effect = [0, RuntimeError("focus failed")]
        with patch.object(g.time, "sleep", lambda _: None):
            with self.assertRaises(RuntimeError):
                ORIGINAL_FOCUS(dict(TARGET))
        self.assertFalse(self.events)
        g.user32.AttachThreadInput.assert_any_call(1, 2, True)
        g.user32.AttachThreadInput.assert_any_call(1, 2, False)

    def test_lease_watch_cannot_expire_inputs_owned_by_starting_run(self):
        g.INPUTS.keys.add("w")
        g.INPUTS.lease_until = time.time() - 1
        r = g.Run([], dict(TARGET), 1, 1280, 80, False)
        with g.INPUTS.lock:
            g.CURRENT["run"] = r
        with patch.object(g.time, "sleep", side_effect=[None, RuntimeError("one tick")]):
            with self.assertRaisesRegex(RuntimeError, "one tick"):
                g.lease_watch()
        self.assertEqual(g.INPUTS.held(), ["w"])
        self.assertFalse(self.events)

    def test_failed_pad_update_is_reset_and_not_forgotten(self):
        g.INPUTS.pad = MagicMock()
        g.INPUTS.vg = MagicMock()
        g.INPUTS.pad.update.side_effect = [RuntimeError("update failed"), RuntimeError("reset failed"), None]
        r = self.run_steps([{"tap": "pad.a"}])
        self.assertEqual(r.state, "failed")
        g.INPUTS.pad.reset.assert_called()
        self.assertFalse(g.INPUTS.held())

    def test_capture_deselects_bitmap_before_getdibits(self):
        selected = [False]
        g.user32.GetDC.return_value = 1
        g.gdi32.CreateCompatibleDC.return_value = 2
        g.gdi32.CreateCompatibleBitmap.return_value = 3
        def select_object(dc, obj):
            selected[0] = obj == 3
            return 4
        g.gdi32.SelectObject.side_effect = select_object
        g.gdi32.BitBlt.return_value = 1
        def dibits(dc, bmp, start, height, *rest):
            self.assertFalse(selected[0])
            return height
        g.gdi32.GetDIBits.side_effect = dibits
        image = MagicMock()
        with patch.dict(sys.modules, {"PIL": SimpleNamespace(Image=image)}):
            g.grab((-100, 0, 20, 10))
        self.assertEqual(g.gdi32.BitBlt.call_args.args[6:8], (-100, 0))
        image.frombuffer.assert_called_once()

    def test_dpi_failure_refuses_to_start_server(self):
        g.user32.SetProcessDpiAwarenessContext.return_value = 0
        g.user32.AreDpiAwarenessContextsEqual.return_value = 0
        with patch.object(ctypes, "get_last_error", lambda: 0, create=True), patch.object(g, "Server") as server:
            with self.assertRaisesRegex(g.StepError, "DPI awareness"):
                g.main()
            server.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
