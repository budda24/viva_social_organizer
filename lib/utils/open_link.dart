import 'package:url_launcher/url_launcher.dart';

/// Schemes the browser/OS hands off to a native handler (mail / dialer / SMS)
/// rather than navigating to as a web page.
const _handoffSchemes = {'mailto', 'tel', 'sms'};

/// Opens [url] the right way on every platform.
///
/// The subtlety is web: `url_launcher_web` ignores [LaunchMode] and only honors
/// `webOnlyWindowName`. With no window name it opens a *new tab* (`window.open`
/// with a blank target) — fine for http(s), but for `mailto:`/`tel:`/`sms:` the
/// new tab tries to *navigate* to the scheme and mobile browsers fail with
/// "This site can't be reached". Opening those in the same tab (`_self`) lets
/// the OS handler intercept the scheme; the current page stays put.
///
/// On native platforms `webOnlyWindowName` is ignored and [LaunchMode] applies,
/// so `mailto:` etc. still open the external mail app as before.
Future<bool> openLink(Uri url) {
  final sameTab = _handoffSchemes.contains(url.scheme.toLowerCase());
  return launchUrl(
    url,
    mode: LaunchMode.externalApplication,
    webOnlyWindowName: sameTab ? '_self' : '_blank',
  );
}
