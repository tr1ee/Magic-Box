using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using MagicBoxLogging;

internal static class LauncherLogWriterHarness
{
    private const string Canary = "MAGIC_BOX_LOG_SECRET_CANARY";

    private static int Main(string[] args)
    {
        if (args.Length != 1)
        {
            return 2;
        }

        var logPath = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(Path.GetDirectoryName(logPath));
        File.WriteAllText(logPath, "legacy https://user:pass@example.test/file?token=" + Canary + "&sig=" + Canary + Environment.NewLine);
        File.WriteAllText(logPath + ".1", "Authorization: Bearer " + Canary + Environment.NewLine);

        Parallel.For(0, 64, delegate(int index)
        {
            LauncherLogWriter.Write(logPath, "worker=" + index + " https://example.test/asset?X-Amz-Signature=" + Canary + "&token=" + Canary);
        });
        var padding = new string('x', 1024 * 1024);
        for (var index = 0; index < 6; index += 1)
        {
            LauncherLogWriter.Write(logPath, padding + " token=" + Canary);
        }

        var files = new[] { logPath, logPath + ".1", logPath + ".2" }.Where(File.Exists).ToArray();
        if (files.Length < 2)
        {
            return 3;
        }
        foreach (var file in files)
        {
            var content = File.ReadAllText(file);
            if (content.IndexOf(Canary, StringComparison.Ordinal) >= 0 || content.IndexOf("user:pass@", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return 4;
            }
            if (content.IndexOf("[redacted]", StringComparison.Ordinal) < 0)
            {
                return 5;
            }
        }
        return 0;
    }
}
