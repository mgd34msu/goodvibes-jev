/**
 * Agent's background-process timeout classification. The caller's explicit
 * class remains code; this reading replaces the fixed leading-program list.
 * A false no can terminate a user's application, so both answers must clear
 * the high-stakes band. Uncertain or failed readings never authorize a spawn.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

export const longLivedProcess = defineBattery({
  name: 'agent.tools.long-lived-process',
  version: 1,
  description: 'Whether a background shell command launches a user-facing application or a server intended to keep running after the call.',
  accuracyFloor: 0.9,
  items: {
    long_lived: yesNo(
      '`command` is a shell command about to start as a tracked background process. Does it launch a user-facing application (such as a browser, editor, office application or media player) or a server intended to keep running after the call? Read the entire command, including wrappers, full paths, shell invocations and arguments. Launching an application or a development/HTTP server is a yes; an ordinary bounded job, build, test, search, sleep or log-following command is a no. Merely mentioning an application or server in quoted output, a search pattern or another argument does not launch it. A utility named open is not necessarily an application launcher: use the command as written and the declared host platform.',
      STAKES_BANDS.high.yesNo,
    ),
  },
  fixtures: [
    ...[
      'brave --new-window https://example.com', 'firefox',
      '/usr/bin/google-chrome --remote-debugging-port=9222', 'chromium-browser about:blank',
      'code /home/u/project', 'xdg-open report.pdf', 'libreoffice report.odt', 'vlc movie.mp4',
      'npm run dev', 'python -m http.server', 'env firefox', 'flatpak run org.mozilla.firefox',
      'sh -c "env firefox about:blank"',
    ].map(command => ({ name: command, state: { command, platform: 'linux' }, expect: { long_lived: 'yes' as const } })),
    ...[
      'bun test', 'npm run build', 'sleep 30', 'tail -f /var/log/syslog',
      'grep -r firefox /etc', 'echo "open chrome"', 'printf "npm run dev"',
      'python -c "print(\"firefox\")"', 'libreoffice --headless --convert-to pdf report.odt',
    ].map(command => ({ name: command, state: { command, platform: 'linux' }, expect: { long_lived: 'no' as const } })),
    { name: 'macOS application launcher', state: { command: 'open report.pdf', platform: 'darwin' }, expect: { long_lived: 'yes' as const } },
    { name: 'Linux openvt one-shot command', state: { command: 'open -- /bin/true', platform: 'linux' }, expect: { long_lived: 'no' as const } },
  ],
});
