import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../data/sample_data.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';
import '../widgets/attendee_card.dart';
import '../widgets/primary_button.dart';
import '../widgets/status_pill.dart';

const String _kInviteCodeDemo = 'VIVA-26-LK7';

// LinkedIn OAuth — public client ID, safe to commit. Secret stays server-side.
const String _kLinkedInClientId = '77zqokaru43u0r';
const String _kLinkedInAuthEndpoint =
    'https://www.linkedin.com/oauth/v2/authorization';
const String _kLinkedInScopes = 'openid profile email';

class InviteScreen extends StatelessWidget {
  const InviteScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;

    return AppScaffold(
      topBarTrailing: const _NotInvitedLink(),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: isCompact ? 24 : 48),
          child: isCompact
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: const [
                    _SignInBlock(),
                    SizedBox(height: 56),
                    _AlreadyInsideBlock(),
                  ],
                )
              : const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: _SignInBlock()),
                    SizedBox(width: 48),
                    Expanded(child: _AlreadyInsideBlock()),
                  ],
                ),
        ),
      ),
    );
  }
}

class _NotInvitedLink extends StatelessWidget {
  const _NotInvitedLink();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'Not invited?  ',
          style: TextStyle(color: AppColors.inkMuted, fontSize: 13),
        ),
        InkWell(
          onTap: () {},
          child: const Text(
            'How it works',
            style: TextStyle(
              color: AppColors.ink,
              fontSize: 13,
              fontWeight: FontWeight.w500,
              decoration: TextDecoration.underline,
              decorationColor: AppColors.ink,
            ),
          ),
        ),
      ],
    );
  }
}

class _SignInBlock extends StatefulWidget {
  const _SignInBlock();

  @override
  State<_SignInBlock> createState() => _SignInBlockState();
}

class _SignInBlockState extends State<_SignInBlock> {
  bool _busy = false;
  String? _error;

  Future<void> _signInWithLinkedIn() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    if (!kIsWeb) {
      // Mobile builds aren't wired up yet — the OAuth redirect flow is web-only.
      setState(() {
        _busy = false;
        _error = 'LinkedIn sign-in is currently web-only.';
      });
      return;
    }
    try {
      // Build the LinkedIn authorization URL and full-page-navigate to it.
      // LinkedIn will redirect back to /auth/linkedin/callback?code=… where
      // LinkedInCallbackScreen exchanges the code via the linkedinSignIn
      // Cloud Function (Firebase Auth's built-in OIDC handler doesn't work
      // with LinkedIn — it uses HTTP Basic auth, LinkedIn requires the
      // secret in the form body).
      final origin = Uri.base.origin;
      final redirectUri = '$origin/auth/linkedin/callback';
      final state = _randomState();

      final authUrl = Uri.parse(_kLinkedInAuthEndpoint).replace(
        queryParameters: {
          'response_type': 'code',
          'client_id': _kLinkedInClientId,
          'redirect_uri': redirectUri,
          'scope': _kLinkedInScopes,
          'state': state,
        },
      );

      web.window.location.assign(authUrl.toString());
      // Page is leaving — nothing else to do here.
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Sign-in failed: $e';
      });
    }
  }

  // Cheap CSRF token. LinkedIn will echo this back as the `state` query param;
  // a future hardening pass can verify it on the callback. Not security-
  // critical for the prototype since the code exchange happens server-side.
  String _randomState() {
    final r = Random.secure();
    final bytes = List<int>.generate(16, (_) => r.nextInt(256));
    return bytes
        .map((b) => b.toRadixString(16).padLeft(2, '0'))
        .join();
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;
    final titleSize = (width * (isCompact ? 0.16 : 0.08)).clamp(56.0, 96.0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(width: 56, height: 3, color: AppColors.accent),
        const SizedBox(height: 28),
        RichText(
          text: TextSpan(
            style: serif(fontSize: titleSize, weight: FontWeight.w500),
            children: [
              const TextSpan(text: "You're "),
              TextSpan(
                text: 'in',
                style: serif(
                  fontSize: titleSize,
                  weight: FontWeight.w400,
                  style: FontStyle.italic,
                  color: AppColors.accent,
                ),
              ),
              const TextSpan(text: '.'),
            ],
          ),
        ),
        const SizedBox(height: 20),
        Text(
          "Sign in to confirm it's you. The rest happens on WhatsApp.",
          style: TextStyle(
            color: AppColors.inkMuted,
            fontSize: isCompact ? 15 : 16,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 28),
        PrimaryButton(
          label: _busy ? 'Signing in…' : 'Continue with LinkedIn',
          onPressed: _busy ? null : _signInWithLinkedIn,
          fullWidth: true,
          shape: ButtonShape.rounded,
          leading: _busy
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppColors.accentInk,
                  ),
                )
              : const Icon(
                  Icons.business_center_rounded,
                  size: 20,
                  color: AppColors.accentInk,
                ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 10),
          Text(
            _error!,
            style: const TextStyle(color: Colors.red, fontSize: 13),
          ),
        ],
        const SizedBox(height: 18),
        const _InviteCodeChip(code: _kInviteCodeDemo),
      ],
    );
  }
}

class _InviteCodeChip extends StatelessWidget {
  const _InviteCodeChip({required this.code});

  final String code;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: AppColors.surfaceTint,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: AppColors.surfaceTintBorder),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'code',
              style: TextStyle(
                color: AppColors.inkMuted,
                fontSize: 11,
                letterSpacing: 1.2,
                fontWeight: FontWeight.w500,
              ),
            ),
            const SizedBox(width: 8),
            Text(code, style: mono(fontSize: 12)),
            const SizedBox(width: 10),
            const Icon(
              Icons.check_circle,
              size: 14,
              color: AppColors.statusGreen,
            ),
            const SizedBox(width: 6),
            const Text(
              'recognised',
              style: TextStyle(color: AppColors.inkMuted, fontSize: 12),
            ),
          ],
        ),
      ),
    );
  }
}

class _AlreadyInsideBlock extends StatelessWidget {
  const _AlreadyInsideBlock();

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: const [
            Text(
              'ALREADY INSIDE',
              style: TextStyle(
                color: AppColors.inkMuted,
                fontSize: 11,
                letterSpacing: 1.4,
                fontWeight: FontWeight.w600,
              ),
            ),
            Spacer(),
            StatusPill(label: '74 / 100'),
          ],
        ),
        const SizedBox(height: 18),
        LayoutBuilder(
          builder: (context, constraints) {
            final columns = constraints.maxWidth < 460 ? 1 : 2;
            const gap = 14.0;
            final cardWidth =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final a in sampleAttendees)
                  SizedBox(width: cardWidth, child: AttendeeCard(attendee: a)),
              ],
            );
          },
        ),
      ],
    );
  }
}
