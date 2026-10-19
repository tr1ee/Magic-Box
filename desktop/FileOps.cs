using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

internal static class FileOps
{
    private const uint GENERIC_READ = 0x80000000;
    private const uint DELETE = 0x00010000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const int FileDispositionInfo = 4;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, IntPtr information, uint size);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);

    private static void Relocate(string source, string destination, string expectedHash)
    {
        source = Path.GetFullPath(source);
        destination = Path.GetFullPath(destination);
        bool destinationLinked = false;
        try
        {
        using (var handle = CreateFile(source, GENERIC_READ | DELETE, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            using (var stream = new FileStream(handle, FileAccess.Read, 1024 * 1024, false))
            using (var sha = SHA256.Create())
            {
                string actualHash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
                if (!String.Equals(actualHash, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("source_fingerprint_changed");
                if (!CreateHardLink(destination, source, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                destinationLinked = true;
                IntPtr buffer = Marshal.AllocHGlobal(1);
                try
                {
                    Marshal.WriteByte(buffer, 1);
                    if (!SetFileInformationByHandle(handle, FileDispositionInfo, buffer, 1))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                    destinationLinked = false;
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
        }
        }
        catch
        {
            if (destinationLinked) try { File.Delete(destination); } catch { }
            throw;
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 4 || args[0] != "relocate") throw new ArgumentException("usage: relocate <source> <destination> <sha256>");
            Relocate(args[1], args[2], args[3]);
            Console.WriteLine("ok");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 2;
        }
    }
}
