import 'package:flutter/foundation.dart';
import 'package:web/web.dart' as web;

/// Acquisition-channel attribution via a `?ref=` URL tag.
///
/// Share a per-channel link — e.g. `…/?ref=linkedin-dm`, `?ref=omnia-outreach`,
/// `?ref=qr-badge` — and we record where each signup came from. The tag is read
/// once at app start and stashed in localStorage, because the LinkedIn OAuth
/// round-trip replaces the query string (the browser returns to `/welcome?code=…`,
/// dropping `?ref=`). On sign-in we read it back and hand it to `linkedinSignIn`,
/// which writes it to the new user's `source` field (first-touch only).

const String _kRefKey = 'viva_ref';
const int _kMaxRefLen = 64;

/// Keep it a short, safe slug — letters, digits, dash, underscore, dot.
String _sanitize(String s) {
  final cleaned = s.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '');
  return cleaned.length > _kMaxRefLen ? cleaned.substring(0, _kMaxRefLen) : cleaned;
}

/// Capture `?ref=` from the current URL into localStorage. First-touch wins:
/// an already-stored tag is not overwritten. Call once, as early as possible in
/// `main()`, before any navigation can rewrite the URL. No-op off the web.
void captureRefTag() {
  if (!kIsWeb) return;
  try {
    final raw = Uri.base.queryParameters['ref'];
    if (raw == null || raw.isEmpty) return;
    final clean = _sanitize(raw);
    if (clean.isEmpty) return;
    final existing = web.window.localStorage.getItem(_kRefKey);
    if (existing == null || existing.isEmpty) {
      web.window.localStorage.setItem(_kRefKey, clean);
    }
  } catch (_) {
    // localStorage can throw in private modes / embedded contexts — best-effort.
  }
}

/// The captured acquisition tag, or null if none was seen. Safe to call anytime.
String? capturedRefTag() {
  if (!kIsWeb) return null;
  try {
    final v = web.window.localStorage.getItem(_kRefKey);
    return (v != null && v.isNotEmpty) ? v : null;
  } catch (_) {
    return null;
  }
}
