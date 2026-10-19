using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace MagicBoxUninstaller
{
    internal static class Program
    {
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\MagicBox";

        [STAThread]
        private static void Main(string[] args)
        {
            if (args.Length >= 2 && args[0] == "--cleanup")
            {
                Cleanup(args[1], args.Length >= 3 && args[2] == "--delete-data");
                return;
            }

            Application.EnableVisualStyles();
            var silent = args.Any(value => string.Equals(value, "/silent", StringComparison.OrdinalIgnoreCase));
            if (!silent)
            {
                var choice = MessageBox.Show(
                    "Remove Magic Box from this PC?\n\nYour downloaded files will not be deleted.",
                    "Uninstall Magic Box",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (choice != DialogResult.Yes)
                {
                    return;
                }
            }

            var removeData = args.Any(value => string.Equals(value, "/delete-data", StringComparison.OrdinalIgnoreCase));
            if (!silent)
            {
                removeData = MessageBox.Show(
                    "Also remove Magic Box settings, voice profiles, and locally installed AI voice models?",
                    "Remove app data?",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                ) == DialogResult.Yes;
            }

            var installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            StopInstalledApp(installDir);
            RemoveShortcuts();
            Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false);

            var helperPath = Path.Combine(Path.GetTempPath(), "MagicBoxUninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Assembly.GetExecutingAssembly().Location, helperPath, true);
            Process.Start(new ProcessStartInfo
            {
                FileName = helperPath,
                Arguments = "--cleanup \"" + installDir + "\"" + (removeData ? " --delete-data" : ""),
                UseShellExecute = false,
                CreateNoWindow = true
            });
        }

        private static void Cleanup(string installDir, bool removeData)
        {
            Thread.Sleep(1500);
            try
            {
                if (Directory.Exists(installDir) && !IsDriveRoot(installDir))
                {
                    Directory.Delete(installDir, true);
                }
                if (removeData)
                {
                    var dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MagicBox");
                    if (Directory.Exists(dataDir)) Directory.Delete(dataDir, true);
                }
            }
            catch
            {
            }
            MoveFileEx(Assembly.GetExecutingAssembly().Location, null, 0x4);
        }

        private static bool IsDriveRoot(string path)
        {
            var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar);
            var root = Path.GetPathRoot(full).TrimEnd(Path.DirectorySeparatorChar);
            return string.Equals(full, root, StringComparison.OrdinalIgnoreCase);
        }

        private static void RemoveShortcuts()
        {
            var startMenuDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Magic Box");
            try { if (Directory.Exists(startMenuDir)) Directory.Delete(startMenuDir, true); } catch { }
            var desktopLink = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Magic Box.lnk");
            try { if (File.Exists(desktopLink)) File.Delete(desktopLink); } catch { }
        }

        private static void StopInstalledApp(string installDir)
        {
            foreach (var process in Process.GetProcessesByName("MagicBox"))
            {
                try
                {
                    if (!string.Equals(Path.GetDirectoryName(process.MainModule.FileName), installDir, StringComparison.OrdinalIgnoreCase)) continue;
                    process.CloseMainWindow();
                    if (!process.WaitForExit(5000)) process.Kill();
                }
                catch { }
                finally { process.Dispose(); }
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool MoveFileEx(string existingFileName, string newFileName, int flags);
    }
}
