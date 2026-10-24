# rabbit-capture.ps1 — helper for tools/rabbit-feed.js. Windows only.
#
# Watches RabbitConnect a few times a second and writes what it shows to
# stdout for rabbit-feed.js: a picture of the board diagram, and the text of
# the fields RabbitConnect keeps for the clocks.
# PASSIVE: it never sends input to RabbitConnect, never touches the board's
# serial port, and works while the window is covered by other windows. The
# picture cannot be taken while the window is minimized (neither can OBS's
# capture of it); the text fields can still be read.
#
# stdout, per tick — one picture line:
#   F <width> <height> <base64 of width*height luminance bytes>   the picture changed
#   =                                                             unchanged, still watching
#   X <reason>                                                    nowindow | minimized | printfail
# and, when RabbitConnect's fields can be found, one text line (tab-separated):
#   T <8 board rows, main window> <8 board rows, driver window> <top clock> <bottom clock> <status>
# The clocks live in RabbitConnect's "DGT RabbitPlugin" driver window, which
# exists (and is kept up to date) whether or not it is showing.
param([int]$IntervalMs = 400)

$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RabbitCap {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsChild(IntPtr parent, IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  const uint PW_CLIENTONLY = 1, PW_RENDERFULLCONTENT = 2;
  const uint WM_GETTEXT = 0x000D, SMTO_ABORTIFHUNG = 2;

  static string Title(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetWindowText(h, sb, 256); return sb.ToString(); }
  static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(128); GetClassName(h, sb, 128); return sb.ToString(); }
  // Reading a control's text is a query, not input: WM_GETTEXT, abandoned if the program is busy.
  static string Text(IntPtr h) {
    if (h == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(256); IntPtr res;
    SendMessageTimeout(h, WM_GETTEXT, (IntPtr)256, sb, SMTO_ABORTIFHUNG, 300, out res);
    return sb.ToString().Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
  }
  static int Top(IntPtr h) { RECT r; GetWindowRect(h, out r); return r.T; }

  static IntPtr mainWin = IntPtr.Zero;      // the visible "RabbitConnect" window (the picture)
  static IntPtr driverWin = IntPtr.Zero;    // "DGT RabbitPlugin": the clocks live here, shown or hidden

  static void FindWindows() {
    mainWin = IntPtr.Zero; driverWin = IntPtr.Zero;
    foreach (Process p in Process.GetProcessesByName("RabbitConnect")) {
      uint want = (uint)p.Id;
      EnumWindows(delegate (IntPtr h, IntPtr l) {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid != want) return true;
        string t = Title(h);
        if (t == "RabbitConnect" && IsWindowVisible(h)) mainWin = h;
        else if (t == "DGT RabbitPlugin") driverWin = h;
        return true;
      }, IntPtr.Zero);
      p.Dispose();
      if (mainWin != IntPtr.Zero || driverWin != IntPtr.Zero) break;
    }
  }

  static List<IntPtr> Children(IntPtr top) {
    List<IntPtr> all = new List<IntPtr>();
    if (top != IntPtr.Zero) EnumChildWindows(top, delegate (IntPtr c, IntPtr l) { all.Add(c); return true; }, IntPtr.Zero);
    return all;
  }

  // The diagram is eight one-line windows of chess-font text, top rank first.
  static IntPtr[] Rows(List<IntPtr> kids) {
    List<IntPtr> rows = new List<IntPtr>();
    foreach (IntPtr c in kids) if (Cls(c) == "wxWindow" && Text(c).Length == 8) rows.Add(c);
    if (rows.Count != 8) return null;
    rows.Sort(delegate (IntPtr a, IntPtr b) { return Top(a).CompareTo(Top(b)); });
    return rows.ToArray();
  }

  static IntPtr[] mainRows, driverRows;
  static IntPtr clockTop, clockBottom, status;
  static DateTime foundAt = DateTime.MinValue;

  static void FindFields() {
    mainRows = Rows(Children(mainWin));
    List<IntPtr> kids = Children(driverWin);
    driverRows = Rows(kids);
    clockTop = clockBottom = status = IntPtr.Zero;
    if (driverRows != null) {
      // The two clocks are the Static controls that sit in their own small
      // panels on the board page, one beside the top rank, one beside the bottom.
      IntPtr rowsPanel = GetParent(driverRows[0]);
      IntPtr page = GetParent(rowsPanel);
      List<IntPtr> clocks = new List<IntPtr>();
      foreach (IntPtr c in kids) {
        if (Cls(c) != "Static") continue;
        IntPtr par = GetParent(c);
        if (par != rowsPanel && par != page && GetParent(par) == page) clocks.Add(c);
      }
      if (clocks.Count == 2) {
        clocks.Sort(delegate (IntPtr a, IntPtr b) { return Top(a).CompareTo(Top(b)); });
        clockTop = clocks[0]; clockBottom = clocks[1];
      }
    }
    // "Board alive" — the Static that follows the Rescan ports button.
    for (int i = 0; i < kids.Count; i++) {
      if (Cls(kids[i]) == "Button" && Text(kids[i]) == "Rescan ports") {
        for (int k = i + 1; k < kids.Count; k++) if (Cls(kids[k]) == "Static") { status = kids[k]; break; }
        break;
      }
    }
    foundAt = DateTime.UtcNow;
  }

  static string TextLine() {
    bool stale = (DateTime.UtcNow - foundAt).TotalSeconds > 10;
    if (stale || (mainRows == null && driverRows == null)) FindFields();
    if (mainRows == null && driverRows == null) return null;
    StringBuilder sb = new StringBuilder("T");
    for (int i = 0; i < 8; i++) sb.Append('\t').Append(mainRows == null ? "" : Text(mainRows[i]));
    for (int i = 0; i < 8; i++) sb.Append('\t').Append(driverRows == null ? "" : Text(driverRows[i]));
    sb.Append('\t').Append(Text(clockTop)).Append('\t').Append(Text(clockBottom)).Append('\t').Append(Text(status));
    return sb.ToString();
  }

  public static void Run(int intervalMs) {
    var o = Console.Out;
    byte[] prev = null;
    int prevW = 0, prevH = 0;
    DateTime lastFull = DateTime.MinValue;
    for (;;) {
      try {
        bool lost = (mainWin == IntPtr.Zero && driverWin == IntPtr.Zero)
          || (mainWin != IntPtr.Zero && (!IsWindow(mainWin) || !IsWindowVisible(mainWin)))
          || (driverWin != IntPtr.Zero && !IsWindow(driverWin))
          || mainWin == IntPtr.Zero;
        if (lost) { FindWindows(); prev = null; mainRows = null; driverRows = null; }
        IntPtr hwnd = mainWin;
        if (hwnd == IntPtr.Zero) { o.WriteLine("X nowindow"); }
        else if (IsIconic(hwnd)) { o.WriteLine("X minimized"); prev = null; }
        else {
          RECT r; GetClientRect(hwnd, out r);
          int w = r.R - r.L, h = r.B - r.T;
          if (w <= 0 || h <= 0) { o.WriteLine("X printfail"); prev = null; }
          else {
            byte[] lum = new byte[w * h];
            bool ok;
            using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
              using (Graphics g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                ok = PrintWindow(hwnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT);
                g.ReleaseHdc(hdc);
              }
              if (ok) {
                BitmapData d = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                byte[] row = new byte[d.Stride];
                for (int y = 0; y < h; y++) {
                  Marshal.Copy(new IntPtr(d.Scan0.ToInt64() + (long)y * d.Stride), row, 0, d.Stride);
                  for (int x = 0; x < w; x++) {
                    int b = row[x * 4], gch = row[x * 4 + 1], rch = row[x * 4 + 2];
                    lum[y * w + x] = (byte)((rch * 299 + gch * 587 + b * 114) / 1000);
                  }
                }
                bmp.UnlockBits(d);
              }
            }
            if (!ok) { o.WriteLine("X printfail"); prev = null; }
            else {
              bool same = prev != null && prevW == w && prevH == h;
              if (same) { for (int i = 0; i < lum.Length; i++) if (lum[i] != prev[i]) { same = false; break; } }
              // Re-send the full picture every 5 s even when nothing changed, so a
              // reader that started late (or was restarted) is never left blind.
              if (same && (DateTime.UtcNow - lastFull).TotalSeconds < 5) o.WriteLine("=");
              else {
                o.WriteLine("F " + w + " " + h + " " + Convert.ToBase64String(lum));
                prev = lum; prevW = w; prevH = h; lastFull = DateTime.UtcNow;
              }
            }
          }
        }
        string t = TextLine();
        if (t != null) o.WriteLine(t);
      } catch (Exception e) {
        o.WriteLine("X error " + e.GetType().Name);
        mainWin = IntPtr.Zero; driverWin = IntPtr.Zero; prev = null; mainRows = null; driverRows = null;
      }
      o.Flush();
      Thread.Sleep(intervalMs);
    }
  }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Drawing
[RabbitCap]::Run($IntervalMs)
