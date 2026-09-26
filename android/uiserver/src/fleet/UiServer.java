package fleet;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.concurrent.TimeoutException;

/**
 * Serves UI-tree dumps from one long-lived UiAutomation connection, so a dump
 * costs a tree walk instead of `uiautomator dump`'s process start and idle wait.
 *
 * Started by adb's shell user through app_process. Listens on 127.0.0.1 only,
 * answers a request only when it carries the token from a file that only the
 * shell user can read, and exits after an idle period so the connection does
 * not outlive the session that needed it. The output matches `uiautomator
 * dump`'s XML, so fleet parses both the same way.
 *
 * Usage: app_process / fleet.UiServer PORT TOKEN-FILE IDLE-MS
 */
public final class UiServer {
    private static final int MAX_DEPTH = 200;

    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(args[0]);
        String token = new String(Files.readAllBytes(Paths.get(args[1])), StandardCharsets.UTF_8).trim();
        int idleMs = Integer.parseInt(args[2]);
        if (token.length() < 16) throw new IllegalArgumentException("token too short");

        // The accessibility client builds its handlers on the main Looper, which a
        // bare app_process does not have until this call.
        Looper.prepareMainLooper();
        HandlerThread thread = new HandlerThread("fleet-ui");
        thread.start();
        UiAutomation ui = connect(thread.getLooper());
        AccessibilityServiceInfo info = ui.getServiceInfo();
        // View ids and the views accessibility would otherwise skip, as uiautomator reports them.
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ui.setServiceInfo(info);

        ServerSocket server = new ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"));
        server.setSoTimeout(idleMs);
        System.out.println("READY " + port);
        System.out.flush();
        while (true) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (SocketTimeoutException idle) {
                break;
            }
            try (Socket s = socket) {
                s.setSoTimeout(5000);
                BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                String line = in.readLine();
                if (line == null) continue;
                String[] parts = line.trim().split(" ", 2);
                if (parts.length != 2 || !parts[0].equals(token)) continue;
                OutputStream out = s.getOutputStream();
                if (parts[1].equals("ping")) out.write("pong\n".getBytes(StandardCharsets.UTF_8));
                else if (parts[1].equals("dump")) out.write(dump(ui).getBytes(StandardCharsets.UTF_8));
                else if (parts[1].equals("quit")) { out.write("bye\n".getBytes(StandardCharsets.UTF_8)); out.flush(); break; }
                out.flush();
            } catch (Exception e) {
                System.out.println("request failed: " + e);
            }
        }
        server.close();
        System.exit(0);
    }

    /** UiAutomation's shell constructor and connect are hidden API; uiautomator
     *  itself reaches them the same way. The flag keeps the user's own
     *  accessibility services running while this connection is held. */
    private static UiAutomation connect(Looper looper) throws Exception {
        Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
        Constructor<?> connectionConstructor = connectionClass.getDeclaredConstructor();
        connectionConstructor.setAccessible(true);
        Object connection = connectionConstructor.newInstance();
        Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
        Constructor<UiAutomation> constructor = UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
        constructor.setAccessible(true);
        UiAutomation ui = constructor.newInstance(looper, connection);
        Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connect.setAccessible(true);
        connect.invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        return ui;
    }

    private static String dump(UiAutomation ui) throws InterruptedException {
        try {
            ui.waitForIdle(100, 1500);
        } catch (TimeoutException busy) {
            // An animating screen never goes idle; dump what is there.
        }
        AccessibilityNodeInfo root = null;
        for (int i = 0; i < 10 && root == null; i++) {
            root = ui.getRootInActiveWindow();
            if (root == null) Thread.sleep(100);
        }
        StringBuilder xml = new StringBuilder(32768);
        xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
        if (root != null) node(root, 0, 0, xml);
        xml.append("</hierarchy>\n");
        return xml.toString();
    }

    private static void node(AccessibilityNodeInfo n, int index, int depth, StringBuilder xml) {
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        xml.append("<node index=\"").append(index).append('"');
        attr(xml, "text", n.getText());
        attr(xml, "resource-id", n.getViewIdResourceName());
        attr(xml, "class", n.getClassName());
        attr(xml, "package", n.getPackageName());
        attr(xml, "content-desc", n.getContentDescription());
        flag(xml, "checkable", n.isCheckable());
        flag(xml, "checked", n.isChecked());
        flag(xml, "clickable", n.isClickable());
        flag(xml, "enabled", n.isEnabled());
        flag(xml, "focusable", n.isFocusable());
        flag(xml, "focused", n.isFocused());
        flag(xml, "scrollable", n.isScrollable());
        flag(xml, "long-clickable", n.isLongClickable());
        flag(xml, "password", n.isPassword());
        flag(xml, "selected", n.isSelected());
        xml.append(" bounds=\"[").append(r.left).append(',').append(r.top).append("][")
            .append(r.right).append(',').append(r.bottom).append("]\"");
        attr(xml, "hint", n.getHintText());
        xml.append('>');
        if (depth < MAX_DEPTH) {
            for (int i = 0; i < n.getChildCount(); i++) {
                AccessibilityNodeInfo child = n.getChild(i);
                if (child == null) continue;
                if (child.isVisibleToUser()) node(child, i, depth + 1, xml);
            }
        }
        xml.append("</node>");
    }

    private static void flag(StringBuilder xml, String name, boolean value) {
        xml.append(' ').append(name).append("=\"").append(value).append('"');
    }

    private static void attr(StringBuilder xml, String name, CharSequence value) {
        xml.append(' ').append(name).append("=\"");
        if (value != null) {
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                switch (c) {
                    case '&': xml.append("&amp;"); break;
                    case '<': xml.append("&lt;"); break;
                    case '>': xml.append("&gt;"); break;
                    case '"': xml.append("&quot;"); break;
                    case '\n': xml.append("&#10;"); break;
                    default: if (c >= 0x20 || c == '\t') xml.append(c);
                }
            }
        }
        xml.append('"');
    }
}
