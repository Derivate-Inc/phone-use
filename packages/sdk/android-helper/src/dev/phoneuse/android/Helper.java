package dev.phoneuse.android;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * phone-use's Android helper: a long-lived process started with app_process
 * from adb shell, the same way `uiautomator dump` runs, but without its
 * "wait until the screen is idle" step and without starting a new process
 * per read. `uiautomator dump` has a ~2 s floor on every observation and ~10 s
 * on screens that never go idle; this answers from a warm accessibility
 * connection in tens of milliseconds.
 *
 * Transport: an abstract-namespace Unix socket. A localhost TCP port would be
 * reachable by every app on the phone, which would let any installed app read
 * the screen; the helper only answers peers running as the shell user (adb
 * forward connects as shell) or root.
 *
 * Protocol: one request per connection. The client writes one line, the
 * command; the helper writes the reply and closes.
 *   ping      → "ok <api level>"
 *   dump      → uiautomator-compatible XML of the active window
 *   foreground → package name of the active window
 *   quit      → stops the helper
 */
public final class Helper {
  private static final int SHELL_UID = 2000;
  private static UiAutomation automation;

  public static void main(String[] args) throws Exception {
    String name = args.length > 0 ? args[0] : "phone-use-helper";
    // app_process starts without a main Looper, and the accessibility client
    // posts its callbacks to it: prepare one, serve from a worker thread, and
    // let the main thread run the loop.
    Looper.prepareMainLooper();
    Thread serving = new Thread(() -> {
      try {
        serve(name);
      } catch (Throwable t) {
        System.err.println("phone-use helper failed: " + t);
        System.exit(1);
      }
    }, "phone-use-server");
    serving.start();
    Looper.loop();
  }

  private static void serve(String name) throws Exception {
    HandlerThread thread = new HandlerThread("phone-use-uiautomation");
    thread.start();
    automation = connect(thread.getLooper());
    try {
      AccessibilityServiceInfo info = automation.getServiceInfo();
      info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
          | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
      automation.setServiceInfo(info);
    } catch (Throwable ignored) {
      // Older releases reject the update; the default flags still work.
    }

    LocalServerSocket server = new LocalServerSocket(name);
    System.out.println("phone-use helper ready on @" + name);
    System.out.flush();
    while (true) {
      LocalSocket socket = server.accept();
      try {
        Credentials peer = socket.getPeerCredentials();
        if (peer.getUid() != SHELL_UID && peer.getUid() != 0) {
          socket.close();
          continue;
        }
        BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
        String command = in.readLine();
        String reply = handle(command == null ? "" : command.trim());
        OutputStream out = socket.getOutputStream();
        out.write(reply.getBytes(StandardCharsets.UTF_8));
        out.flush();
        if ("quit".equals(command)) {
          socket.close();
          System.exit(0);
        }
      } catch (Throwable t) {
        // One bad request must not end the helper.
      } finally {
        try {
          socket.close();
        } catch (Throwable ignored) {
        }
      }
    }
  }

  /**
   * UiAutomation's constructor and connect() are hidden API, reached by
   * reflection; the constructor's signature changed across releases, so try
   * the known shapes. FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES keeps the
   * user's own accessibility services (TalkBack) running.
   */
  private static UiAutomation connect(Looper looper) throws Exception {
    Class<?> connectionClass = Class.forName("android.app.UiAutomationConnection");
    Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
    Constructor<?> connectionCtor = connectionClass.getDeclaredConstructor();
    connectionCtor.setAccessible(true);
    Object connection = connectionCtor.newInstance();
    Constructor<UiAutomation> ctor = UiAutomation.class.getDeclaredConstructor(Looper.class, connectionInterface);
    ctor.setAccessible(true);
    UiAutomation ua = ctor.newInstance(looper, connection);
    try {
      Method connectWithFlags = UiAutomation.class.getDeclaredMethod("connect", int.class);
      connectWithFlags.setAccessible(true);
      connectWithFlags.invoke(ua, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
    } catch (NoSuchMethodException e) {
      Method connect = UiAutomation.class.getDeclaredMethod("connect");
      connect.setAccessible(true);
      connect.invoke(ua);
    }
    return ua;
  }

  private static String handle(String command) {
    switch (command) {
      case "ping":
        return "ok " + android.os.Build.VERSION.SDK_INT;
      case "foreground": {
        AccessibilityNodeInfo root = activeRoot();
        return root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
      }
      case "dump":
        return dump();
      case "quit":
        return "bye";
      default:
        return "error unknown command";
    }
  }

  private static AccessibilityNodeInfo activeRoot() {
    // Right after a window change the root can briefly be null; a short retry
    // covers that without the idle wait.
    for (int i = 0; i < 20; i++) {
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      if (root != null) return root;
      SystemClock.sleep(25);
    }
    return null;
  }

  private static String dump() {
    AccessibilityNodeInfo root = activeRoot();
    StringBuilder xml = new StringBuilder(64 * 1024);
    xml.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
    if (root != null) {
      Rect screen = new Rect();
      root.getBoundsInScreen(screen);
      append(xml, root, 0, screen, 0);
    }
    xml.append("</hierarchy>");
    return xml.toString();
  }

  private static void append(StringBuilder xml, AccessibilityNodeInfo node, int index, Rect screen, int depth) {
    if (node == null || depth > 100) return;
    if (!node.isVisibleToUser()) return;
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    // Clip to the screen and drop empty boxes (uiautomator emitted a node with
    // a negative height on the Settings root).
    if (!bounds.intersect(screen) || bounds.width() <= 0 || bounds.height() <= 0) {
      if (node.getChildCount() == 0) return;
      bounds.setEmpty();
    }
    xml.append("<node index=\"").append(index).append('"');
    attr(xml, "text", node.getText());
    attr(xml, "resource-id", node.getViewIdResourceName());
    attr(xml, "class", node.getClassName());
    attr(xml, "package", node.getPackageName());
    attr(xml, "content-desc", node.getContentDescription());
    flag(xml, "checkable", node.isCheckable());
    flag(xml, "checked", node.isChecked());
    flag(xml, "clickable", node.isClickable());
    flag(xml, "enabled", node.isEnabled());
    flag(xml, "focusable", node.isFocusable());
    flag(xml, "focused", node.isFocused());
    flag(xml, "scrollable", node.isScrollable());
    flag(xml, "long-clickable", node.isLongClickable());
    flag(xml, "password", node.isPassword());
    flag(xml, "selected", node.isSelected());
    xml.append(" bounds=\"[").append(bounds.left).append(',').append(bounds.top).append("][")
        .append(bounds.right).append(',').append(bounds.bottom).append("]\">");
    int count = node.getChildCount();
    for (int i = 0; i < count; i++) {
      AccessibilityNodeInfo child = node.getChild(i);
      if (child != null) append(xml, child, i, screen, depth + 1);
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
          case '\r': xml.append("&#13;"); break;
          default:
            if (c >= 0x20 || c == '\t') xml.append(c);
        }
      }
    }
    xml.append('"');
  }
}
