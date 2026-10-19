using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Net;
using System.Speech.Recognition;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MagicBoxWebView2
{
    internal static class Program
    {
        private static readonly Regex ServerRegex = new Regex(
            @"Torrent API listening at (http://127\.0\.0\.1:\d+)",
            RegexOptions.Compiled
        );
        private static IntPtr serverJobHandle = IntPtr.Zero;

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            Process server = null;
            try
            {
                var appDir = AppDomain.CurrentDomain.BaseDirectory;
                // The app directory is a deployable build artifact. Settings,
                // profiles, model weights, and logs belong to the per-user data
                // directory for both installed and direct portable launches.
                // This keeps rebuilds/upgrades from accumulating private state
                // inside release/chromium/MagicBox.
                var dataDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MagicBox"
                );
                var logDir = Path.Combine(dataDir, "logs");
                Directory.CreateDirectory(logDir);
                var logPath = Path.Combine(logDir, "MagicBox-launch.log");
                var settingsPath = Path.Combine(dataDir, "settings.json");
                MigratePortableSettings(appDir, settingsPath, logPath);
                MigratePortableVoiceData(appDir, dataDir, logPath);
                Log(logPath, "Starting Magic Box WebView2 host.");

                string appUrl;
                server = StartLocalEngine(appDir, settingsPath, logPath, out appUrl);
                if (Array.Exists(args, value => String.Equals(value, "--diagnostic-smoke", StringComparison.OrdinalIgnoreCase)))
                {
                    using (var client = new WebClient())
                    {
                        var status = client.DownloadString(appUrl + "/api/assistant/status");
                        if (!status.Contains("\"localOnly\":true") || !status.Contains("\"state\":\"ready\""))
                            throw new InvalidDataException("Assistant diagnostic status was not ready and local-only.");
                    }
                    Log(logPath, "Diagnostic smoke passed: packaged Assistant is ready and local-only.");
                    return;
                }
                Application.Run(new MagicBoxWindow(appDir, appUrl, server, logPath));
            }
            catch (Exception ex)
            {
                try
                {
                    var fallbackLogDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "MagicBox",
                        "logs"
                    );
                    Directory.CreateDirectory(fallbackLogDir);
                    Log(Path.Combine(fallbackLogDir, "MagicBox-launch.log"), ex.ToString());
                }
                catch
                {
                }
                MessageBox.Show(ex.Message, "Magic Box", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                StopProcess(server);
                CloseServerJob();
            }
        }

        private static void MigratePortableSettings(string appDir, string settingsPath, string logPath)
        {
            if (File.Exists(settingsPath))
            {
                return;
            }

            var portableSettingsPath = Path.Combine(appDir, "MagicBox-settings.json");
            if (!File.Exists(portableSettingsPath))
            {
                return;
            }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(settingsPath));
                File.Copy(portableSettingsPath, settingsPath, false);
                Log(logPath, "Migrated portable settings to the per-user data folder.");
            }
            catch (Exception ex)
            {
                Log(logPath, "Could not migrate portable settings: " + ex.Message);
            }
        }

        private static void MigratePortableVoiceData(string appDir, string dataDir, string logPath)
        {
            var portableVoicePath = Path.Combine(appDir, "voice_clone");
            var userVoicePath = Path.Combine(dataDir, "voice_clone");
            if (!Directory.Exists(portableVoicePath) || Directory.Exists(userVoicePath))
            {
                return;
            }

            try
            {
                Directory.CreateDirectory(dataDir);
                Directory.Move(portableVoicePath, userVoicePath);
                Log(logPath, "Migrated portable voice data to the per-user data folder.");
            }
            catch (Exception ex)
            {
                Log(logPath, "Could not migrate portable voice data: " + ex.Message);
            }
        }

        private static Process StartLocalEngine(string appDir, string settingsPath, string logPath, out string appUrl)
        {
            var nodePath = Path.Combine(appDir, "node.exe");
            if (!File.Exists(nodePath))
            {
                nodePath = "node.exe";
            }

            var ready = new ManualResetEvent(false);
            var failed = new ManualResetEvent(false);
            string detectedUrl = null;
            var startupError = "";
            var dataDir = Path.GetDirectoryName(settingsPath);
            if (String.IsNullOrWhiteSpace(dataDir))
            {
                throw new InvalidOperationException("Magic Box could not resolve its data directory.");
            }
            var downloadsDir = Path.Combine(dataDir, "downloads");
            var tempDir = Path.Combine(dataDir, "temp");
            Directory.CreateDirectory(downloadsDir);
            Directory.CreateDirectory(tempDir);

            Environment.SetEnvironmentVariable("PORT", "0", EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable(
                "TORRENT_DOWNLOAD_DIR",
                downloadsDir,
                EnvironmentVariableTarget.Process
            );
            Environment.SetEnvironmentVariable("TEMP", tempDir, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("TMP", tempDir, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("TMPDIR", tempDir, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable(
                "MAGIC_BOX_SETTINGS_FILE",
                settingsPath,
                EnvironmentVariableTarget.Process
            );
            // Older direct WebView2 builds stored Private Agent state beside
            // the executable. Keep using that complete data root until it is
            // explicitly migrated; switching only the settings path would make
            // installed Qwen models appear missing even though their weights
            // and database rows are still intact.
            var portableAssistantDir = Path.Combine(appDir, "assistant");
            var configuredAssistantDir = Environment.GetEnvironmentVariable("MAGIC_BOX_ASSISTANT_DATA_DIR");
            if (String.IsNullOrWhiteSpace(configuredAssistantDir)
                && File.Exists(Path.Combine(portableAssistantDir, "assistant.sqlite3"))
                && Directory.Exists(Path.Combine(portableAssistantDir, "models")))
            {
                Environment.SetEnvironmentVariable(
                    "MAGIC_BOX_ASSISTANT_DATA_DIR",
                    portableAssistantDir,
                    EnvironmentVariableTarget.Process
                );
                Log(logPath, "Using the existing portable Private Agent data root.");
            }

            var serverStart = new ProcessStartInfo
            {
                FileName = nodePath,
                Arguments = "server/index.mjs",
                WorkingDirectory = appDir,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            ConfigureVoicePipeline();
            Log(logPath, "Voice optimized pipeline defaults: " + (Environment.GetEnvironmentVariable("VOICE_OPTIMIZED_PIPELINE") ?? "0") + ".");
            Log(logPath, "Voice input experiments: " + (Environment.GetEnvironmentVariable("VOICE_BARGE_IN") == "1" ? "enabled" : "off") + ".");
            Log(logPath, "Runtime temporary files use " + tempDir + ".");

            var server = new Process
            {
                StartInfo = serverStart,
                EnableRaisingEvents = true
            };

            server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (string.IsNullOrEmpty(args.Data))
                {
                    return;
                }

                Log(logPath, args.Data);
                var match = ServerRegex.Match(args.Data);
                if (match.Success)
                {
                    detectedUrl = match.Groups[1].Value;
                    ready.Set();
                }
            };
            server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (!string.IsNullOrEmpty(args.Data))
                {
                    startupError += args.Data + Environment.NewLine;
                    Log(logPath, args.Data);
                }
            };
            server.Exited += delegate
            {
                if (detectedUrl == null)
                {
                    failed.Set();
                }
            };

            server.Start();
            AttachServerToJob(server, logPath);
            server.BeginOutputReadLine();
            server.BeginErrorReadLine();

            var signaled = WaitHandle.WaitAny(new WaitHandle[] { ready, failed }, TimeSpan.FromSeconds(20));
            if (signaled != 0 || string.IsNullOrEmpty(detectedUrl))
            {
                StopProcess(server);
                throw new InvalidOperationException(FriendlyStartupError(startupError));
            }

            appUrl = detectedUrl;
            Log(logPath, "Opening " + appUrl + " in WebView2.");
            return server;
        }

        private static void ConfigureVoicePipeline()
        {
            if (string.Equals(Environment.GetEnvironmentVariable("VOICE_OPTIMIZED_PIPELINE"), "0", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }

            SetIfUnset("VOICE_OPTIMIZED_PIPELINE", "1");
            SetIfUnset("VOICE_STATEFUL_RESAMPLER", "1");
            SetIfUnset("VOICE_PERSISTENT_TTS_SESSION", "1");
            SetIfUnset("VOICE_BINARY_WORKER_IPC", "1");
            SetIfUnset("VOICE_AUTO_GPU_LAYERS", "1");
            if (string.Equals(Environment.GetEnvironmentVariable("VOICE_OPTIMIZED_INPUT"), "1", StringComparison.OrdinalIgnoreCase))
            {
                SetIfUnset("VOICE_PARTIAL_ASR", "1");
                SetIfUnset("VOICE_BARGE_IN", "1");
            }
        }

        private static void SetIfUnset(string name, string value)
        {
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(name)))
            {
                Environment.SetEnvironmentVariable(name, value, EnvironmentVariableTarget.Process);
            }
        }

        private static string FriendlyStartupError(string startupError)
        {
            if (string.IsNullOrWhiteSpace(startupError))
            {
                return "The local engine did not start.";
            }

            if (startupError.IndexOf("EADDRINUSE", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return "The local engine port is already in use. Magic Box will try a private port after rebuilding.";
            }

            return startupError.Trim();
        }

        internal static void StopProcess(Process process)
        {
            if (process == null)
            {
                return;
            }

            try
            {
                if (!process.HasExited)
                {
                    process.Kill();
                    process.WaitForExit(3000);
                }
            }
            catch
            {
            }
            finally
            {
                process.Dispose();
            }
        }

        private static void AttachServerToJob(Process process, string logPath)
        {
            try
            {
                var job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero)
                {
                    Log(logPath, "Could not create cleanup job: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                    return;
                }

                var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

                var infoLength = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
                var infoPointer = Marshal.AllocHGlobal(infoLength);
                try
                {
                    Marshal.StructureToPtr(info, infoPointer, false);
                    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, infoPointer, (uint)infoLength))
                    {
                        Log(logPath, "Could not configure cleanup job: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                        CloseHandle(job);
                        return;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(infoPointer);
                }

                if (!AssignProcessToJobObject(job, process.Handle))
                {
                    Log(logPath, "Could not attach local engine to cleanup job: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
                    CloseHandle(job);
                    return;
                }

                serverJobHandle = job;
            }
            catch (Exception ex)
            {
                Log(logPath, ex.ToString());
            }
        }

        private static void CloseServerJob()
        {
            var job = serverJobHandle;
            if (job == IntPtr.Zero)
            {
                return;
            }

            serverJobHandle = IntPtr.Zero;
            try
            {
                CloseHandle(job);
            }
            catch
            {
            }
        }

        internal static void Log(string path, string message)
        {
            MagicBoxLogging.LauncherLogWriter.Write(path, message);
        }

        private const int JobObjectExtendedLimitInformation = 9;
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr hJob,
            int jobObjectInfoClass,
            IntPtr lpJobObjectInfo,
            uint cbJobObjectInfoLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }
    }

    internal sealed class MagicBoxWindow : Form
    {
        private readonly string appDir;
        private readonly string appUrl;
        private readonly string logPath;
        private Process server;
        private WebView2 webView;
        private Label loadingLabel;
        private NotifyIcon notifyIcon;
        private readonly object speechRecognitionLock = new object();
        private SpeechRecognitionEngine speechRecognizer;
        private bool speechRecognitionStarting;
        private bool allowClose;

        public MagicBoxWindow(string appDir, string appUrl, Process server, string logPath)
        {
            this.appDir = appDir;
            this.appUrl = appUrl;
            this.server = server;
            this.logPath = logPath;

            Text = "Magic Box";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(1024, 720);
            ClientSize = new Size(1486, 1057);
            BackColor = Color.White;

            var iconPath = Path.Combine(appDir, "app-icon.ico");
            if (File.Exists(iconPath))
            {
                Icon = new Icon(iconPath);
            }

            notifyIcon = new NotifyIcon
            {
                Icon = Icon ?? SystemIcons.Application,
                Text = "Magic Box",
                Visible = true
            };
            notifyIcon.DoubleClick += delegate { RestoreFromTray(); };
            var trayMenu = new ContextMenuStrip();
            trayMenu.Items.Add("Open Magic Box", null, delegate { RestoreFromTray(); });
            trayMenu.Items.Add(new ToolStripSeparator());
            trayMenu.Items.Add("Exit Magic Box", null, delegate
            {
                allowClose = true;
                Close();
            });
            notifyIcon.ContextMenuStrip = trayMenu;

            loadingLabel = new Label
            {
                Dock = DockStyle.Fill,
                Text = "Starting Magic Box...",
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI", 13F, FontStyle.Bold),
                ForeColor = Color.FromArgb(9, 39, 71),
                BackColor = Color.White
            };
            Controls.Add(loadingLabel);

            Shown += delegate { InitializeWebView(); };
            FormClosing += delegate(object sender, FormClosingEventArgs args)
            {
                if (allowClose)
                {
                    return;
                }

                var choice = AskCloseChoice();
                if (choice == CloseChoice.Exit)
                {
                    allowClose = true;
                    return;
                }

                args.Cancel = true;
                if (choice == CloseChoice.Background)
                {
                    HideToTray();
                }
            };
            FormClosed += delegate
            {
                Program.Log(logPath, "Window closed; stopping local engine.");
                StopSpeechRecognition();
                if (notifyIcon != null)
                {
                    notifyIcon.Visible = false;
                    notifyIcon.Dispose();
                    notifyIcon = null;
                }
                Program.StopProcess(server);
                server = null;
            };
        }

        private enum CloseChoice
        {
            Cancel,
            Exit,
            Background
        }

        private CloseChoice AskCloseChoice()
        {
            using (var dialog = new CloseChoiceDialog())
            {
                var result = dialog.ShowDialog(this);
                if (result == DialogResult.Yes)
                {
                    return CloseChoice.Exit;
                }
                if (result == DialogResult.No)
                {
                    return CloseChoice.Background;
                }
                return CloseChoice.Cancel;
            }
        }

        private sealed class CloseChoiceDialog : Form
        {
            private static readonly Color SurfaceColor = Color.FromArgb(5, 20, 18);
            private static readonly Color BorderColor = Color.FromArgb(35, 135, 138);
            private static readonly Color PrimaryColor = Color.FromArgb(54, 211, 211);
            private static readonly Color PinkColor = Color.FromArgb(233, 100, 151);
            private static readonly Color BodyColor = Color.FromArgb(147, 169, 166);
            private static readonly Color ButtonSurfaceColor = Color.FromArgb(7, 31, 29);

            internal CloseChoiceDialog()
            {
                Text = "Close Magic Box";
                StartPosition = FormStartPosition.CenterParent;
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                MinimizeBox = false;
                MaximizeBox = false;
                ClientSize = new Size(520, 260);
                BackColor = SurfaceColor;
                KeyPreview = true;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

                var brandDot = new Panel
                {
                    BackColor = PinkColor,
                    Location = new Point(32, 30),
                    Size = new Size(6, 6)
                };
                var brand = CreateLabel("MAGIC BOX", new Point(50, 23), new Size(130, 20), 9F, FontStyle.Bold, PinkColor);
                var title = CreateLabel("Keep running in the background?", new Point(32, 63), new Size(456, 28), 15F, FontStyle.Regular, Color.FromArgb(243, 247, 246));
                var description = CreateLabel("Downloads and local services will stay active.", new Point(32, 103), new Size(456, 22), 9.5F, FontStyle.Regular, BodyColor);
                var divider = new Panel
                {
                    BackColor = Color.FromArgb(28, 63, 60),
                    Location = new Point(32, 143),
                    Size = new Size(456, 1)
                };

                var backgroundButton = CreateButton(
                    "Run in background",
                    new Point(32, 172),
                    new Size(150, 42),
                    PrimaryColor,
                    ButtonSurfaceColor,
                    Color.FromArgb(12, 76, 76),
                    0,
                    DialogResult.No
                );
                var closeButton = CreateButton(
                    "Close completely",
                    new Point(198, 172),
                    new Size(178, 42),
                    Color.FromArgb(231, 241, 239),
                    SurfaceColor,
                    Color.FromArgb(10, 53, 52),
                    1,
                    DialogResult.Yes
                );
                var cancelButton = CreateButton(
                    "Cancel",
                    new Point(405, 172),
                    new Size(83, 42),
                    Color.FromArgb(148, 169, 166),
                    SurfaceColor,
                    Color.FromArgb(12, 43, 41),
                    0,
                    DialogResult.Cancel
                );

                AcceptButton = backgroundButton;
                CancelButton = cancelButton;
                Controls.Add(brandDot);
                Controls.Add(brand);
                Controls.Add(title);
                Controls.Add(description);
                Controls.Add(divider);
                Controls.Add(backgroundButton);
                Controls.Add(closeButton);
                Controls.Add(cancelButton);
                Region = CreateRoundedRegion(ClientRectangle, 14);
            }

            protected override void OnPaint(PaintEventArgs args)
            {
                args.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                using (var path = CreateRoundedPath(new Rectangle(0, 0, ClientSize.Width - 1, ClientSize.Height - 1), 14))
                using (var borderPen = new Pen(BorderColor, 1F))
                using (var surfaceBrush = new SolidBrush(SurfaceColor))
                {
                    args.Graphics.FillPath(surfaceBrush, path);
                    args.Graphics.DrawPath(borderPen, path);
                }
                base.OnPaint(args);
            }

            private static Label CreateLabel(string text, Point location, Size size, float fontSize, FontStyle fontStyle, Color color)
            {
                return new Label
                {
                    AutoSize = false,
                    Location = location,
                    Size = size,
                    Text = text,
                    Font = new Font("Segoe UI", fontSize, fontStyle),
                    ForeColor = color,
                    BackColor = Color.Transparent,
                    TextAlign = ContentAlignment.MiddleLeft
                };
            }

            private static Button CreateButton(string text, Point location, Size size, Color foreground, Color background, Color hoverBackground, int borderSize, DialogResult dialogResult)
            {
                var button = new Button
                {
                    AutoSize = false,
                    Location = location,
                    Size = size,
                    Text = text,
                    Font = new Font("Segoe UI", 9F, FontStyle.Regular),
                    ForeColor = foreground,
                    BackColor = background,
                    FlatStyle = FlatStyle.Flat,
                    DialogResult = dialogResult,
                    TabStop = true,
                    UseVisualStyleBackColor = false
                };
                button.FlatAppearance.BorderSize = borderSize;
                button.FlatAppearance.BorderColor = BorderColor;
                button.FlatAppearance.MouseOverBackColor = hoverBackground;
                button.FlatAppearance.MouseDownBackColor = hoverBackground;
                return button;
            }

            private static Region CreateRoundedRegion(Rectangle bounds, int radius)
            {
                using (var path = CreateRoundedPath(bounds, radius))
                {
                    return new Region(path);
                }
            }

            private static GraphicsPath CreateRoundedPath(Rectangle bounds, int radius)
            {
                var diameter = radius * 2;
                var path = new GraphicsPath();
                path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180, 90);
                path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270, 90);
                path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
                path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90, 90);
                path.CloseFigure();
                return path;
            }
        }

        private void HideToTray()
        {
            Program.Log(logPath, "Window hidden to the notification area; local engine continues running.");
            WindowState = FormWindowState.Minimized;
            Hide();
        }

        private void RestoreFromTray()
        {
            if (IsDisposed || Disposing)
            {
                return;
            }

            Show();
            WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        private void InitializeWebView()
        {
            webView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.White
            };
            Controls.Add(webView);
            webView.BringToFront();

            var userDataFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MagicBox",
                "WebView2Profile"
            );
            Directory.CreateDirectory(userDataFolder);

            var fixedRuntimeFolder = Path.Combine(
                appDir,
                "vendor",
                "webview2-fixed",
                "150.0.4078.65",
                "Microsoft.WebView2.FixedVersionRuntime.150.0.4078.65.x64"
            );
            var browserExecutableFolder = File.Exists(Path.Combine(fixedRuntimeFolder, "msedgewebview2.exe"))
                ? fixedRuntimeFolder
                : null;
            Program.Log(logPath, browserExecutableFolder == null
                ? "Fixed WebView2 runtime not found; using installed Evergreen runtime."
                : "Using private fixed WebView2 runtime 150.0.4078.65.");

            CoreWebView2Environment.CreateAsync(browserExecutableFolder, userDataFolder)
                .ContinueWith(
                    delegate(Task<CoreWebView2Environment> environmentTask)
                    {
                        if (environmentTask.IsFaulted)
                        {
                            ShowStartupError(environmentTask.Exception);
                            return;
                        }

                        webView.EnsureCoreWebView2Async(environmentTask.Result)
                            .ContinueWith(
                                delegate(Task initTask)
                                {
                                    if (initTask.IsFaulted)
                                    {
                                        ShowStartupError(initTask.Exception);
                                        return;
                                    }

                                    ConfigureWebView();
                                    webView.CoreWebView2.Navigate(appUrl);
                                },
                                TaskScheduler.FromCurrentSynchronizationContext()
                            );
                    },
                    TaskScheduler.FromCurrentSynchronizationContext()
                );
        }

        private void ConfigureWebView()
        {
            webView.CoreWebView2.AddHostObjectToScript("magicBoxHost", new MagicBoxHostBridge(this));

            webView.CoreWebView2.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args)
            {
                if (args.PermissionKind != CoreWebView2PermissionKind.Microphone)
                {
                    return;
                }
                Uri requestedOrigin;
                Uri localAppOrigin;
                if (Uri.TryCreate(args.Uri, UriKind.Absolute, out requestedOrigin)
                    && Uri.TryCreate(appUrl, UriKind.Absolute, out localAppOrigin)
                    && requestedOrigin.IsLoopback
                    && requestedOrigin.Port == localAppOrigin.Port)
                {
                    args.State = CoreWebView2PermissionState.Allow;
                    Program.Log(logPath, "Microphone permission allowed for the local Magic Box origin.");
                }
                else
                {
                    args.State = CoreWebView2PermissionState.Deny;
                    Program.Log(logPath, "Microphone permission denied for a non-local origin.");
                }
            };

            webView.NavigationCompleted += delegate
            {
                if (loadingLabel != null)
                {
                    Controls.Remove(loadingLabel);
                    loadingLabel.Dispose();
                    loadingLabel = null;
                }
            };

            webView.CoreWebView2.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args)
            {
                Program.Log(logPath, "WebView2 process failed: " + args.ProcessFailedKind);
            };

            webView.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs args)
            {
                args.Handled = true;
                try
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = args.Uri,
                        UseShellExecute = true
                    });
                }
                catch (Exception ex)
                {
                    Program.Log(logPath, ex.ToString());
                }
            };

            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = false;
            webView.CoreWebView2.Settings.IsStatusBarEnabled = false;
            webView.CoreWebView2.Settings.IsZoomControlEnabled = false;
        }

        internal void ShowDesktopNotification(string title, string message, string tone)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action(delegate { ShowDesktopNotification(title, message, tone); }));
                return;
            }

            if (notifyIcon == null || string.IsNullOrWhiteSpace(message))
            {
                return;
            }

            var icon = ToolTipIcon.Info;
            if (string.Equals(tone, "error", StringComparison.OrdinalIgnoreCase))
            {
                icon = ToolTipIcon.Error;
            }
            else if (string.Equals(tone, "warn", StringComparison.OrdinalIgnoreCase))
            {
                icon = ToolTipIcon.Warning;
            }

            notifyIcon.ShowBalloonTip(
                8000,
                LimitBalloonText(title, 63, "Magic Box"),
                LimitBalloonText(message, 255, "Scan finished."),
                icon
            );
        }

        internal void StartSpeechRecognition(string language)
        {
            lock (speechRecognitionLock)
            {
                if (speechRecognitionStarting || speechRecognizer != null)
                {
                    PostSpeechMessage("magic-box:speech:error:busy:Voice input is already running.");
                    return;
                }
                speechRecognitionStarting = true;
            }

            var worker = new Thread(new ThreadStart(delegate { RunSpeechRecognition(language); }));
            worker.IsBackground = true;
            worker.Name = "Magic Box speech recognition";
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
        }

        internal void StopSpeechRecognition()
        {
            SpeechRecognitionEngine recognizer;
            lock (speechRecognitionLock)
            {
                recognizer = speechRecognizer;
                speechRecognitionStarting = false;
            }
            try
            {
                if (recognizer != null)
                {
                    recognizer.RecognizeAsyncCancel();
                }
            }
            catch
            {
            }
        }

        private void RunSpeechRecognition(string language)
        {
            SpeechRecognitionEngine recognizer = null;
            var completed = new ManualResetEvent(false);
            string transcript = null;
            bool cancelled = false;
            try
            {
                var recognizerInfo = SelectSpeechRecognizer(language);
                if (recognizerInfo == null)
                {
                    PostSpeechMessage("magic-box:speech:error:language-not-supported:No offline Windows speech recognizer is installed for this language.");
                    return;
                }

                recognizer = new SpeechRecognitionEngine(recognizerInfo);
                lock (speechRecognitionLock)
                {
                    speechRecognizer = recognizer;
                    speechRecognitionStarting = false;
                }

                recognizer.LoadGrammar(new DictationGrammar());
                recognizer.SetInputToDefaultAudioDevice();
                recognizer.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs args)
                {
                    if (args.Result != null && args.Result.Confidence >= 0.25f)
                    {
                        transcript = args.Result.Text;
                    }
                };
                recognizer.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs args)
                {
                    cancelled = args.Cancelled;
                    completed.Set();
                };

                PostSpeechMessage("magic-box:speech:started");
                recognizer.RecognizeAsync(RecognizeMode.Single);
                if (!completed.WaitOne(TimeSpan.FromSeconds(25)))
                {
                    recognizer.RecognizeAsyncCancel();
                    completed.WaitOne(TimeSpan.FromSeconds(2));
                }

                if (cancelled)
                {
                    PostSpeechMessage("magic-box:speech:stopped");
                }
                else if (!string.IsNullOrWhiteSpace(transcript))
                {
                    PostSpeechMessage("magic-box:speech:result:" + transcript.Trim());
                }
                else
                {
                    PostSpeechMessage("magic-box:speech:error:no-speech:I didn't hear any speech. Try again a little closer to the microphone.");
                }
            }
            catch (UnauthorizedAccessException)
            {
                PostSpeechMessage("magic-box:speech:error:not-allowed:Microphone access was not allowed. Enable it in Windows privacy settings and try again.");
            }
            catch (InvalidOperationException exception)
            {
                Program.Log(logPath, "Offline speech recognition could not start: " + exception.Message);
                PostSpeechMessage("magic-box:speech:error:audio-capture:Windows could not start the microphone. Check the input device and try again.");
            }
            catch (Exception exception)
            {
                Program.Log(logPath, "Offline speech recognition failed: " + exception);
                PostSpeechMessage("magic-box:speech:error:recognition-failed:Offline voice input stopped unexpectedly. Please try again.");
            }
            finally
            {
                lock (speechRecognitionLock)
                {
                    if (ReferenceEquals(speechRecognizer, recognizer))
                    {
                        speechRecognizer = null;
                    }
                    speechRecognitionStarting = false;
                }
                if (recognizer != null)
                {
                    try { recognizer.Dispose(); } catch { }
                }
                completed.Dispose();
            }
        }

        private static RecognizerInfo SelectSpeechRecognizer(string language)
        {
            CultureInfo requested = null;
            try
            {
                if (!string.IsNullOrWhiteSpace(language))
                {
                    requested = CultureInfo.GetCultureInfo(language);
                }
            }
            catch (CultureNotFoundException)
            {
            }

            RecognizerInfo languageMatch = null;
            RecognizerInfo englishFallback = null;
            RecognizerInfo first = null;
            foreach (var info in SpeechRecognitionEngine.InstalledRecognizers())
            {
                if (first == null) first = info;
                if (string.Equals(info.Culture.Name, "en-US", StringComparison.OrdinalIgnoreCase)) englishFallback = info;
                if (requested == null) continue;
                if (string.Equals(info.Culture.Name, requested.Name, StringComparison.OrdinalIgnoreCase)) return info;
                if (languageMatch == null && string.Equals(info.Culture.TwoLetterISOLanguageName, requested.TwoLetterISOLanguageName, StringComparison.OrdinalIgnoreCase)) languageMatch = info;
            }
            return languageMatch ?? englishFallback ?? first;
        }

        private void PostSpeechMessage(string message)
        {
            if (IsDisposed || Disposing) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    try
                    {
                        if (webView != null && webView.CoreWebView2 != null)
                        {
                            webView.CoreWebView2.PostWebMessageAsString(message);
                        }
                    }
                    catch (Exception exception)
                    {
                        Program.Log(logPath, "Could not deliver speech result: " + exception.Message);
                    }
                }));
            }
            catch
            {
            }
        }

        private static string LimitBalloonText(string value, int maxLength, string fallback)
        {
            var text = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
            if (text.Length <= maxLength)
            {
                return text;
            }

            return text.Substring(0, Math.Max(0, maxLength - 3)) + "...";
        }

        private void ShowStartupError(Exception exception)
        {
            var message = exception == null
                ? "WebView2 failed to start."
                : exception.GetBaseException().Message;
            Program.Log(logPath, exception == null ? message : exception.ToString());
            MessageBox.Show(message, "Magic Box", MessageBoxButtons.OK, MessageBoxIcon.Error);
            allowClose = true;
            Close();
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.AutoDual)]
    public sealed class MagicBoxHostBridge
    {
        private readonly MagicBoxWindow window;

        internal MagicBoxHostBridge(MagicBoxWindow window)
        {
            this.window = window;
        }

        public void Notify(string title, string message, string tone)
        {
            window.ShowDesktopNotification(title, message, tone);
        }

        public void StartSpeechRecognition(string language)
        {
            window.StartSpeechRecognition(language);
        }

        public void StopSpeechRecognition()
        {
            window.StopSpeechRecognition();
        }
    }
}
