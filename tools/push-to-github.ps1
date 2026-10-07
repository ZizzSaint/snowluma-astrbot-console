# Read the GitHub token from Windows Credential Manager and hand it to the Node publisher.
# The token is passed to the child process via an environment variable only: never written to
# disk, never printed.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File tools\push-to-github.ps1 [repo-name] [node-script] [script-args...]
#   default repo-name = snowluma-astrbot-console, default node-script = tools/push-to-github.js
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CredManToken {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    public static string[] Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return null;
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            string blob = Marshal.PtrToStringUni(cred.CredentialBlob, (int)(cred.CredentialBlobSize / 2));
            return new string[] { cred.UserName, blob };
        } finally {
            CredFree(ptr);
        }
    }
}
'@

$repo = if ($args.Count -ge 1) { $args[0] } else { 'snowluma-astrbot-console' }
$script = if ($args.Count -ge 2) { $args[1] } else { 'tools/push-to-github.js' }
$rest = @()
if ($args.Count -gt 2) { $rest = $args[2..($args.Count - 1)] }
$cred = [CredManToken]::Read('git:https://github.com')
if (-not $cred) {
    Write-Error 'No git:https://github.com credential found in Windows Credential Manager.'
    exit 1
}

$env:GH_TOKEN = $cred[1]
$env:GH_REPO = $repo
$env:GH_OWNER = $cred[0]

Push-Location (Join-Path $PSScriptRoot '..')
$code = 1
try {
    if ($rest.Count -gt 0) {
        node $script @rest
    } else {
        node $script
    }
    $code = $LASTEXITCODE
} finally {
    Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
}
exit $code
