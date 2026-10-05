using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

// No webview: the shared Node controller verifies the service and chooses URLs.
class Tray : ApplicationContext {
    NotifyIcon icon;
    Process host;
    Control dispatch = new Control();
    bool ending, smoke, smokeStop;
    ToolStripMenuItem status = new ToolStripMenuItem("Starting LineBridge...");
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    public Tray(string[] args) {
        smoke = args.Contains("--smoke-test");
        smokeStop = args.Contains("--smoke-stop");
        string root = AppDomain.CurrentDomain.BaseDirectory;
        dispatch.CreateControl(); status.Enabled = false;
        var menu = new ContextMenuStrip(); menu.Items.Add(status);
        menu.Items.Add("Open LineBridge", null, (s,e) => Send("open"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit tray (keep service running)", null, (s,e) => Send("quit"));
        menu.Items.Add("Stop service and quit", null, (s,e) => Send("stop"));
        icon = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = "LineBridge", ContextMenuStrip = menu, Visible = !smoke };
        icon.MouseClick += (s,e) => { if(e.Button == MouseButtons.Left) Send("open"); };
        var options = new[] {Path.Combine(root,"app","server","tray.mjs")}.Concat(args.Where(a => a != "--smoke-test" && a != "--smoke-stop"));
        host = new Process { StartInfo = new ProcessStartInfo {
            FileName = Path.Combine(root,"runtime","node.exe"),
            Arguments = string.Join(" ", options.Select(Quote)),
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        }, EnableRaisingEvents = true };
        host.OutputDataReceived += (s,e) => Post(() => { if(e.Data != null) Receive(e.Data); else if(!ending) { Error("Tray controller exited. The service may still be running; use linebridge status."); Finish(); } });
        host.ErrorDataReceived += (s,e) => {}; // Node runtime diagnostics are not user content.
        host.Start(); host.BeginOutputReadLine(); host.BeginErrorReadLine();
    }
    void Post(Action action) { if(!ending && !dispatch.IsDisposed) try { dispatch.BeginInvoke(action); } catch(InvalidOperationException) {} }
    void Send(string action) { try { host.StandardInput.WriteLine(action); host.StandardInput.Flush(); } catch(Exception e) { Error(e.Message); } }
    void Error(string text) { if(smoke) { Console.WriteLine("error\t" + text); Environment.ExitCode = 1; } else MessageBox.Show(text,"LineBridge",MessageBoxButtons.OK,MessageBoxIcon.Error); }
    void Receive(string line) {
        int split = line.IndexOf('\t'); string kind = split < 0 ? line : line.Substring(0,split), value = split < 0 ? "" : line.Substring(split+1);
        if(smoke) Console.WriteLine(line);
        if(kind == "ready") { status.Text = "LineBridge running"; Send("open"); }
        else if(kind == "state") status.Text = value;
        else if(kind == "error") Error(value);
        else if(kind == "quit") Finish();
        else if(kind == "open") {
            Uri url;
            if(!Uri.TryCreate(value,UriKind.Absolute,out url) || url.Scheme != "http" || url.Host != "127.0.0.1" || url.Port <= 1024 || url.UserInfo != "" || url.AbsolutePath != "/" || url.Query != "" || url.Fragment != "") { Error("Invalid local dashboard URL."); return; }
            if(smoke) Send(smokeStop ? "stop" : "quit");
            else try { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); } catch(Exception e) { Error(e.Message); }
        }
    }
    void Finish() { if(ending)return; ending=true; icon.Visible=false; icon.Dispose(); try { host.StandardInput.Close(); } catch {} dispatch.Dispose(); ExitThread(); }
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles();
        try { Application.Run(new Tray(args)); } catch(Exception e) { if(args.Contains("--smoke-test")) Console.WriteLine("error\t"+e.Message); else MessageBox.Show(e.Message,"LineBridge"); Environment.ExitCode=1; }
    }
}
