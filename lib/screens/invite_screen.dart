import 'dart:math';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../data/sample_data.dart';
import '../models/event.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';
import '../widgets/attendee_card.dart';
import '../widgets/event_card.dart';
import '../widgets/primary_button.dart';
import '../widgets/status_pill.dart';

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
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: isCompact ? 24 : 48),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (isCompact)
                const Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _SignInBlock(),
                    SizedBox(height: 56),
                    _AlreadyInsideBlock(),
                  ],
                )
              else
                const Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: _SignInBlock()),
                    SizedBox(width: 48),
                    Expanded(child: _AlreadyInsideBlock()),
                  ],
                ),
              SizedBox(height: isCompact ? 56 : 72),
              const _AlreadyHappeningBlock(),
            ],
          ),
        ),
      ),
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
      // Redirect straight to /welcome — WelcomeScreen reads the `code` from
      // the URL on mount and runs the OAuth exchange before rendering the
      // welcome UI. Eliminates the intermediate /auth/linkedin/callback page.
      final redirectUri = '$origin/welcome';
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
      ],
    );
  }
}

class _AlreadyHappeningBlock extends StatelessWidget {
  const _AlreadyHappeningBlock();

  static const _emojiByKind = {
    'breakfast': '🍳',
    'coffee': '☕',
    'lunch': '🥗',
    'drinks': '🥂',
    'dinner': '🍝',
    'rooftop': '🌇',
    'walk': '🚶',
    'side-event': '🎟️',
    'other': '📍',
  };

  static const _days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  static const _months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];

  static String _dayLabel(DateTime dt) {
    final l = dt.toLocal();
    final dn = _days[(l.weekday - 1).clamp(0, 6)];
    final mn = _months[(l.month - 1).clamp(0, 11)];
    return '$dn · ${l.day} $mn';
  }

  Event _fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> doc) {
    final d = doc.data();
    final kind = (d['kind'] as String?) ?? 'other';
    final title = (d['title'] as String?) ?? '(untitled)';
    final hostName = (d['hostName'] as String?) ?? 'A member';
    final startAt = d['startAt'];
    final day = startAt is Timestamp ? _dayLabel(startAt.toDate()) : '';
    final emoji = _emojiByKind[kind] ?? '📍';
    return Event(
      emoji: emoji,
      title: title,
      day: day,
      organizer: hostName,
    );
  }

  @override
  Widget build(BuildContext context) {
    final stream = FirebaseFirestore.instance
        .collection('events')
        .where('status', whereIn: ['scheduled', 'live'])
        .orderBy('startAt')
        .limit(12)
        .snapshots();

    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: stream,
      builder: (context, snap) {
        // Don't render anything until the first snapshot resolves — avoids
        // flashing the "be first" empty state on a cold load that's about to
        // populate. Firestore's offline cache makes this near-instant on
        // warm loads.
        if (snap.connectionState == ConnectionState.waiting) {
          return const SizedBox.shrink();
        }
        final events = (snap.data?.docs ?? const [])
            .map(_fromDoc)
            .toList(growable: false);
        final isEmpty = events.isEmpty;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'ALREADY HAPPENING',
                  style: TextStyle(
                    color: AppColors.inkMuted,
                    fontSize: 11,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                StatusPill(
                  label: isEmpty
                      ? 'Nobody yet · be first'
                      : '${events.length} live · sign in for details',
                ),
              ],
            ),
            const SizedBox(height: 18),
            if (isEmpty)
              const _EmptyHappeningState(example: _exampleEvent)
            else
              LayoutBuilder(
                builder: (context, constraints) {
                  final w = constraints.maxWidth;
                  final columns = w < 460
                      ? 2
                      : w < 720
                      ? 3
                      : w < 1000
                      ? 4
                      : 5;
                  const gap = 12.0;
                  final cardWidth =
                      (constraints.maxWidth - gap * (columns - 1)) / columns;
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      for (final e in events)
                        SizedBox(width: cardWidth, child: EventCard(event: e)),
                    ],
                  );
                },
              ),
          ],
        );
      },
    );
  }

  // Hardcoded illustrative card shown next to the "be first" CTA in the empty
  // state. Clearly labelled EXAMPLE so it isn't mistaken for a real event.
  static const _exampleEvent = Event(
    emoji: '☕',
    title: 'Founders coffee',
    day: 'FRI · 19 JUN',
    organizer: 'You',
  );
}

class _EmptyHappeningState extends StatelessWidget {
  const _EmptyHappeningState({required this.example});

  final Event example;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isCompact = constraints.maxWidth < 640;
        final cta = Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: AppColors.cardBg,
            border: Border.all(color: AppColors.cardBorder),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Be the first to schedule something',
                style: serif(fontSize: 22, weight: FontWeight.w500),
              ),
              const SizedBox(height: 10),
              const Text(
                'Sign in, message the bot, say "drinks tonight at 8" — it pings '
                'every member who fits. Breakfast, walk, demo, dinner — '
                'anything works.',
                style: TextStyle(
                  color: AppColors.inkMuted,
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
            ],
          ),
        );

        final exampleCard = Stack(
          children: [
            EventCard(event: example, gated: false),
            Positioned(
              top: 10,
              right: 10,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surfaceTint,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: AppColors.surfaceTintBorder),
                ),
                child: const Text(
                  'EXAMPLE',
                  style: TextStyle(
                    color: AppColors.inkMuted,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
          ],
        );

        if (isCompact) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              cta,
              const SizedBox(height: 16),
              exampleCard,
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: cta),
            const SizedBox(width: 24),
            SizedBox(width: 240, child: exampleCard),
          ],
        );
      },
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
        const Text(
          'ALREADY INSIDE',
          style: TextStyle(
            color: AppColors.inkMuted,
            fontSize: 11,
            letterSpacing: 1.4,
            fontWeight: FontWeight.w600,
          ),
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
