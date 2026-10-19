using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MagicBoxInstaller
{
    internal static class Program
    {
        internal const string AppName = "Magic Box";
        internal const string Version = "0.1.0";
        private const string PayloadMagic = "MBXSETUP2026";
        private const int FooterSize = 28;

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var silent = args.Any(value => string.Equals(value, "/silent", StringComparison.OrdinalIgnoreCase));
            var noLaunch = args.Any(value => string.Equals(value, "/no-launch", StringComparison.OrdinalIgnoreCase));
            var installDirArgument = args.FirstOrDefault(value => value.StartsWith("/install-dir=", StringComparison.OrdinalIgnoreCase));
            var defaultInstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "MagicBox"
            );
            var installDir = installDirArgument == null
                ? defaultInstallDir
                : installDirArgument.Substring("/install-dir=".Length).Trim('"');

            if (silent)
            {
                try
                {
                    InstallerEngine.Install(installDir, true, null);
                    if (!noLaunch)
                    {
                        InstallerEngine.Launch(installDir);
                    }
                    Environment.ExitCode = 0;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(ex);
                    Environment.ExitCode = 1;
                }
                return;
            }

            Application.Run(new InstallerForm(installDir, noLaunch));
        }

        internal static PayloadInfo ReadPayloadInfo()
        {
            var setupPath = Assembly.GetExecutingAssembly().Location;
            using (var stream = new FileStream(setupPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length < FooterSize)
                {
                    throw new InvalidDataException("This setup file does not contain the Magic Box application payload.");
                }

                stream.Seek(-FooterSize, SeekOrigin.End);
                using (var reader = new BinaryReader(stream, Encoding.ASCII, true))
                {
                    var magic = Encoding.ASCII.GetString(reader.ReadBytes(12));
                    var offset = reader.ReadInt64();
                    var length = reader.ReadInt64();
                    if (magic != PayloadMagic || offset < 0 || length <= 0 || offset + length + FooterSize != stream.Length)
                    {
                        throw new InvalidDataException("The Magic Box setup payload is missing or damaged.");
                    }
                    return new PayloadInfo(setupPath, offset, length);
                }
            }
        }

        internal sealed class PayloadInfo
        {
            internal PayloadInfo(string setupPath, long offset, long length)
            {
                SetupPath = setupPath;
                Offset = offset;
                Length = length;
            }

            internal string SetupPath { get; private set; }
            internal long Offset { get; private set; }
            internal long Length { get; private set; }
        }
    }

    internal sealed class InstallerForm : Form
    {
        private readonly TextBox installPath;
        private readonly CheckBox desktopShortcut;
        private readonly CheckBox launchAfterInstall;
        private readonly ProgressBar progress;
        private readonly Label status;
        private readonly Button installButton;

        internal InstallerForm(string defaultInstallDir, bool noLaunch)
        {
            Text = "Install Magic Box";
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(610, 430);
            MinimumSize = new Size(610, 430);
            MaximizeBox = false;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            BackColor = Color.FromArgb(246, 249, 252);
            Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location);

            var header = new Panel { Dock = DockStyle.Top, Height = 122, BackColor = Color.FromArgb(10, 42, 74) };
            var title = new Label
            {
                Text = "Magic Box",
                ForeColor = Color.White,
                Font = new Font("Segoe UI", 23F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(30, 23)
            };
            var subtitle = new Label
            {
                Text = "One installer for the complete Windows desktop app",
                ForeColor = Color.FromArgb(202, 221, 237),
                Font = new Font("Segoe UI", 10.5F),
                AutoSize = true,
                Location = new Point(33, 75)
            };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            Controls.Add(header);

            var pathLabel = new Label
            {
                Text = "Install location",
                Font = new Font("Segoe UI", 9.5F, FontStyle.Bold),
                AutoSize = true,
                Location = new Point(32, 148)
            };
            Controls.Add(pathLabel);

            installPath = new TextBox
            {
                Text = defaultInstallDir,
                Font = new Font("Segoe UI", 9.5F),
                Location = new Point(35, 174),
                Size = new Size(442, 27)
            };
            Controls.Add(installPath);

            var browse = new Button
            {
                Text = "Browse...",
                Location = new Point(487, 172),
                Size = new Size(88, 31),
                FlatStyle = FlatStyle.System
            };
            browse.Click += delegate
            {
                using (var picker = new FolderBrowserDialog())
                {
                    picker.Description = "Choose where Magic Box will be installed.";
                    picker.SelectedPath = installPath.Text;
                    if (picker.ShowDialog(this) == DialogResult.OK)
                    {
                        installPath.Text = Path.Combine(picker.SelectedPath, "MagicBox");
                    }
                }
            };
            Controls.Add(browse);

            desktopShortcut = new CheckBox
            {
                Text = "Create a desktop shortcut",
                Checked = true,
                AutoSize = true,
                Font = new Font("Segoe UI", 9.5F),
                Location = new Point(35, 221)
            };
            Controls.Add(desktopShortcut);

            launchAfterInstall = new CheckBox
            {
                Text = "Launch Magic Box after installation",
                Checked = !noLaunch,
                Enabled = !noLaunch,
                AutoSize = true,
                Font = new Font("Segoe UI", 9.5F),
                Location = new Point(35, 251)
            };
            Controls.Add(launchAfterInstall);

            var note = new Label
            {
                Text = "Large AI voice models are installed on demand inside the app and are kept separate from app upgrades.",
                ForeColor = Color.FromArgb(74, 88, 103),
                Font = new Font("Segoe UI", 8.8F),
                Location = new Point(35, 286),
                Size = new Size(540, 36)
            };
            Controls.Add(note);

            progress = new ProgressBar
            {
                Location = new Point(35, 329),
                Size = new Size(540, 18),
                Style = ProgressBarStyle.Continuous
            };
            Controls.Add(progress);

            status = new Label
            {
                Text = "Ready to install",
                ForeColor = Color.FromArgb(74, 88, 103),
                AutoSize = true,
                Location = new Point(35, 354)
            };
            Controls.Add(status);

            installButton = new Button
            {
                Text = "Install",
                Font = new Font("Segoe UI", 10F, FontStyle.Bold),
                ForeColor = Color.White,
                BackColor = Color.FromArgb(18, 112, 171),
                FlatStyle = FlatStyle.Flat,
                Location = new Point(455, 374),
                Size = new Size(120, 38)
            };
            installButton.FlatAppearance.BorderSize = 0;
            installButton.Click += InstallClicked;
            AcceptButton = installButton;
            Controls.Add(installButton);
        }

        private async void InstallClicked(object sender, EventArgs eventArgs)
        {
            var destination = installPath.Text.Trim();
            if (string.IsNullOrWhiteSpace(destination))
            {
                MessageBox.Show(this, "Choose an install location.", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            ToggleInputs(false);
            status.Text = "Preparing application files...";
            var reporter = new Progress<int>(value =>
            {
                progress.Value = Math.Max(0, Math.Min(100, value));
                status.Text = value < 92 ? "Installing application files..." : "Creating shortcuts...";
            });

            try
            {
                await Task.Run(() => InstallerEngine.Install(destination, desktopShortcut.Checked, reporter));
                progress.Value = 100;
                status.Text = "Installation complete";
                if (launchAfterInstall.Checked)
                {
                    InstallerEngine.Launch(destination);
                }
                MessageBox.Show(this, "Magic Box is installed and ready to use.", Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch (Exception ex)
            {
                status.Text = "Installation failed";
                MessageBox.Show(this, ex.Message, "Magic Box setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
                ToggleInputs(true);
            }
        }

        private void ToggleInputs(bool enabled)
        {
            installPath.Enabled = enabled;
            desktopShortcut.Enabled = enabled;
            installButton.Enabled = enabled;
            UseWaitCursor = !enabled;
        }
    }

    internal static class InstallerEngine
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MagicBox";

        internal static void Install(string requestedInstallDir, bool createDesktopShortcut, IProgress<int> progress)
        {
            var installDir = Path.GetFullPath(Environment.ExpandEnvironmentVariables(requestedInstallDir));
            ValidateInstallDirectory(installDir);
            StopInstalledApp(installDir);

            var parent = Directory.GetParent(installDir);
            if (parent == null)
            {
                throw new InvalidOperationException("Choose a normal folder for the installation.");
            }
            Directory.CreateDirectory(parent.FullName);

            var stagingDir = Path.Combine(parent.FullName, ".MagicBox-installing-" + Guid.NewGuid().ToString("N"));
            var backupDir = Path.Combine(parent.FullName, ".MagicBox-backup-" + Guid.NewGuid().ToString("N"));
            try
            {
                ExtractPayload(stagingDir, progress);
                var appExe = Path.Combine(stagingDir, "MagicBox.exe");
                if (!File.Exists(appExe) || !File.Exists(Path.Combine(stagingDir, "node.exe")))
                {
                    throw new InvalidDataException("The setup payload is incomplete.");
                }

                if (Directory.Exists(installDir))
                {
                    Directory.Move(installDir, backupDir);
                }

                try
                {
                    Directory.Move(stagingDir, installDir);
                }
                catch
                {
                    if (Directory.Exists(backupDir) && !Directory.Exists(installDir))
                    {
                        Directory.Move(backupDir, installDir);
                    }
                    throw;
                }

                if (progress != null) progress.Report(94);
                EnsureWebView2Runtime(installDir);
                CreateShortcuts(installDir, createDesktopShortcut);
                RegisterUninstaller(installDir);
                if (progress != null) progress.Report(100);

                if (Directory.Exists(backupDir))
                {
                    Directory.Delete(backupDir, true);
                }
            }
            finally
            {
                TryDeleteDirectory(stagingDir);
            }
        }

        private static void ExtractPayload(string destination, IProgress<int> progress)
        {
            var payload = Program.ReadPayloadInfo();
            Directory.CreateDirectory(destination);
            using (var packageFile = new FileStream(payload.SetupPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var segment = new SegmentStream(packageFile, payload.Offset, payload.Length))
            using (var archive = new ZipArchive(segment, ZipArchiveMode.Read, false))
            {
                var entries = archive.Entries;
                var total = Math.Max(1, entries.Count);
                var destinationRoot = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
                for (var index = 0; index < entries.Count; index++)
                {
                    var entry = entries[index];
                    var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    var target = Path.GetFullPath(Path.Combine(destination, relative));
                    if (!target.StartsWith(destinationRoot, StringComparison.OrdinalIgnoreCase))
                    {
                        throw new InvalidDataException("The setup payload contains an invalid path.");
                    }

                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(target);
                    }
                    else
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (var input = entry.Open())
                        using (var output = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            input.CopyTo(output);
                        }
                    }
                    if (progress != null) progress.Report(3 + (int)Math.Round((index + 1) * 88.0 / total));
                }
            }
        }

        private static void EnsureWebView2Runtime(string installDir)
        {
            if (WebView2IsInstalled())
            {
                TryDeleteDirectory(Path.Combine(installDir, "_setup"));
                return;
            }

            var bootstrapper = Path.Combine(installDir, "_setup", "MicrosoftEdgeWebView2Setup.exe");
            if (!File.Exists(bootstrapper))
            {
                throw new InvalidOperationException("Microsoft WebView2 Runtime is required but was not found on this PC.");
            }

            using (var process = Process.Start(new ProcessStartInfo
            {
                FileName = bootstrapper,
                Arguments = "/silent /install",
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(bootstrapper)
            }))
            {
                process.WaitForExit(10 * 60 * 1000);
                if (!process.HasExited || process.ExitCode != 0)
                {
                    throw new InvalidOperationException("Microsoft WebView2 Runtime could not be installed. Connect this PC to the internet and run setup again.");
                }
            }
            TryDeleteDirectory(Path.Combine(installDir, "_setup"));
        }

        private static bool WebView2IsInstalled()
        {
            var roots = new[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
            };
            foreach (var root in roots.Where(value => !string.IsNullOrWhiteSpace(value)))
            {
                var applicationDir = Path.Combine(root, "Microsoft", "EdgeWebView", "Application");
                try
                {
                    if (Directory.Exists(applicationDir) && Directory.GetFiles(applicationDir, "msedgewebview2.exe", SearchOption.AllDirectories).Any())
                    {
                        return true;
                    }
                }
                catch
                {
                }
            }
            return false;
        }

        private static void CreateShortcuts(string installDir, bool createDesktopShortcut)
        {
            var target = Path.Combine(installDir, "MagicBox.exe");
            var startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Magic Box");
            Directory.CreateDirectory(startMenuDir);
            CreateShortcut(Path.Combine(startMenuDir, "Magic Box.lnk"), target, installDir);
            CreateShortcut(Path.Combine(startMenuDir, "Uninstall Magic Box.lnk"), Path.Combine(installDir, "MagicBoxUninstall.exe"), installDir);

            var desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Magic Box.lnk");
            if (createDesktopShortcut)
            {
                CreateShortcut(desktopLink, target, installDir);
            }
            else if (File.Exists(desktopLink))
            {
                File.Delete(desktopLink);
            }
        }

        private static void CreateShortcut(string shortcutPath, string targetPath, string workingDirectory)
        {
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                throw new InvalidOperationException("Windows shortcut support is unavailable.");
            }
            object shellObject = null;
            object shortcutObject = null;
            try
            {
                shellObject = Activator.CreateInstance(shellType);
                dynamic shell = shellObject;
                shortcutObject = shell.CreateShortcut(shortcutPath);
                dynamic shortcut = shortcutObject;
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = workingDirectory;
                shortcut.IconLocation = targetPath + ",0";
                shortcut.Description = "Magic Box desktop downloader";
                shortcut.Save();
            }
            finally
            {
                if (shortcutObject != null && Marshal.IsComObject(shortcutObject)) Marshal.FinalReleaseComObject(shortcutObject);
                if (shellObject != null && Marshal.IsComObject(shellObject)) Marshal.FinalReleaseComObject(shellObject);
            }
        }

        private static void RegisterUninstaller(string installDir)
        {
            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", Program.AppName);
                key.SetValue("DisplayVersion", Program.Version);
                key.SetValue("Publisher", "Magic Box");
                key.SetValue("DisplayIcon", Path.Combine(installDir, "MagicBox.exe"));
                key.SetValue("InstallLocation", installDir);
                key.SetValue("UninstallString", "\"" + Path.Combine(installDir, "MagicBoxUninstall.exe") + "\"");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
        }

        private static void StopInstalledApp(string installDir)
        {
            foreach (var process in Process.GetProcessesByName("MagicBox"))
            {
                try
                {
                    var processPath = process.MainModule.FileName;
                    if (!string.Equals(Path.GetDirectoryName(processPath), installDir.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }
                    process.CloseMainWindow();
                    if (!process.WaitForExit(5000))
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
        }

        internal static void Launch(string installDir)
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = Path.Combine(installDir, "MagicBox.exe"),
                WorkingDirectory = installDir,
                UseShellExecute = true
            });
        }

        private static void ValidateInstallDirectory(string installDir)
        {
            var root = Path.GetPathRoot(installDir);
            if (string.IsNullOrWhiteSpace(root) || string.Equals(root.TrimEnd(Path.DirectorySeparatorChar), installDir.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Magic Box cannot be installed at the root of a drive.");
            }
        }

        private static void TryDeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path)) Directory.Delete(path, true);
            }
            catch
            {
            }
        }
    }

    internal sealed class SegmentStream : Stream
    {
        private readonly Stream source;
        private readonly long start;
        private readonly long length;
        private long position;

        internal SegmentStream(Stream source, long start, long length)
        {
            this.source = source;
            this.start = start;
            this.length = length;
            position = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return position; } set { Seek(value, SeekOrigin.Begin); } }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (position >= length) return 0;
            count = (int)Math.Min(count, length - position);
            lock (source)
            {
                source.Position = start + position;
                var read = source.Read(buffer, offset, count);
                position += read;
                return read;
            }
        }
        public override long Seek(long offset, SeekOrigin origin)
        {
            long next;
            if (origin == SeekOrigin.Begin) next = offset;
            else if (origin == SeekOrigin.Current) next = position + offset;
            else next = length + offset;
            if (next < 0 || next > length) throw new IOException("Attempted to seek outside the setup payload.");
            position = next;
            return position;
        }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}
