using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace MagicBoxLogging
{
    public static class LauncherLogWriter
    {
        private const long MaxPrimaryBytes = 5L * 1024L * 1024L;
        private const int MaxArchives = 2;
        private static readonly object StateGate = new object();
        private static readonly Dictionary<string, object> PathLocks = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        private static readonly HashSet<string> InitializedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Regex HttpUrl = new Regex(@"https?://[^\s<>""']+", RegexOptions.Compiled | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        private static readonly Regex SensitiveAssignment = new Regex(
            @"(?ix)(?<prefix>\b(?:authorization|proxy-authorization|cookie|set-cookie|token|access_token|id_token|signature|sig|upsig|key|x-amz-[a-z0-9-]+|x-goog-[a-z0-9-]+)\b\s*[:=]\s*)(?:bearer\s+|basic\s+)?[^\s,;]+",
            RegexOptions.Compiled | RegexOptions.CultureInvariant
        );
        private static readonly Regex BearerValue = new Regex(@"(?ix)\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        public static void Write(string path, string message)
        {
            try
            {
                var normalizedPath = Path.GetFullPath(path);
                var pathLock = GetPathLock(normalizedPath);
                lock (pathLock)
                {
                    var directory = Path.GetDirectoryName(normalizedPath);
                    if (!String.IsNullOrEmpty(directory))
                    {
                        Directory.CreateDirectory(directory);
                    }
                    EnsureSanitized(normalizedPath);
                    RotateIfNeeded(normalizedPath);
                    File.AppendAllText(
                        normalizedPath,
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                            + " " + Redact(message) + Environment.NewLine,
                        Encoding.UTF8
                    );
                }
            }
            catch
            {
            }
        }

        public static string Redact(string value)
        {
            var source = value ?? String.Empty;
            var changed = false;
            var redacted = HttpUrl.Replace(source, delegate(Match match)
            {
                var raw = match.Value;
                try
                {
                    var uri = new Uri(raw, UriKind.Absolute);
                    if (String.IsNullOrEmpty(uri.Query) && String.IsNullOrEmpty(uri.Fragment) && String.IsNullOrEmpty(uri.UserInfo))
                    {
                        return raw;
                    }
                    changed = true;
                    var authority = uri.Scheme + "://" + uri.Host + (uri.IsDefaultPort ? String.Empty : ":" + uri.Port.ToString(CultureInfo.InvariantCulture));
                    return authority + uri.AbsolutePath + "[redacted]";
                }
                catch
                {
                    var queryIndex = raw.IndexOfAny(new[] { '?', '#' });
                    if (queryIndex < 0)
                    {
                        return raw;
                    }
                    changed = true;
                    return raw.Substring(0, queryIndex) + "[redacted]";
                }
            });
            redacted = SensitiveAssignment.Replace(redacted, delegate(Match match)
            {
                changed = true;
                return match.Groups["prefix"].Value + "[redacted]";
            });
            redacted = BearerValue.Replace(redacted, delegate
            {
                changed = true;
                return "[redacted]";
            });
            return changed && redacted.IndexOf("[redacted]", StringComparison.Ordinal) < 0
                ? redacted + " [redacted]"
                : redacted;
        }

        private static object GetPathLock(string normalizedPath)
        {
            lock (StateGate)
            {
                object pathLock;
                if (!PathLocks.TryGetValue(normalizedPath, out pathLock))
                {
                    pathLock = new object();
                    PathLocks[normalizedPath] = pathLock;
                }
                return pathLock;
            }
        }

        private static void EnsureSanitized(string normalizedPath)
        {
            lock (StateGate)
            {
                if (InitializedPaths.Contains(normalizedPath))
                {
                    return;
                }
                InitializedPaths.Add(normalizedPath);
            }

            SanitizeFileAtomically(normalizedPath);
            for (var archive = 1; archive <= MaxArchives; archive += 1)
            {
                SanitizeFileAtomically(ArchivePath(normalizedPath, archive));
            }
        }

        private static void RotateIfNeeded(string normalizedPath)
        {
            var info = new FileInfo(normalizedPath);
            if (!info.Exists || info.Length < MaxPrimaryBytes)
            {
                return;
            }

            SanitizeFileAtomically(normalizedPath);
            var oldest = ArchivePath(normalizedPath, MaxArchives);
            if (File.Exists(oldest))
            {
                File.Delete(oldest);
            }
            for (var archive = MaxArchives - 1; archive >= 1; archive -= 1)
            {
                var current = ArchivePath(normalizedPath, archive);
                if (File.Exists(current))
                {
                    File.Move(current, ArchivePath(normalizedPath, archive + 1));
                }
            }
            File.Move(normalizedPath, ArchivePath(normalizedPath, 1));
        }

        private static void SanitizeFileAtomically(string path)
        {
            if (!File.Exists(path))
            {
                return;
            }

            var replacement = path + ".redacting-" + Guid.NewGuid().ToString("N");
            try
            {
                string content;
                using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                using (var reader = new StreamReader(input, Encoding.UTF8, true))
                {
                    content = reader.ReadToEnd();
                }
                File.WriteAllText(replacement, Redact(content), Encoding.UTF8);
                File.Replace(replacement, path, null);
            }
            finally
            {
                if (File.Exists(replacement))
                {
                    try
                    {
                        File.Delete(replacement);
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static string ArchivePath(string path, int archive)
        {
            return path + "." + archive.ToString(CultureInfo.InvariantCulture);
        }
    }
}
