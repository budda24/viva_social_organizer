import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../config/channel_links.dart';
import '../data/sample_data.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../utils/open_link.dart';
import '../widgets/app_scaffold.dart';
import '../widgets/chat_buttons.dart';
import '../widgets/mini_speaker_card.dart';
import '../widgets/status_pill.dart';

// Mirror of the Telegram webhook's INVITE_CODE_PATTERN
// (functions/src/channels/telegram/webhook.ts). A code that doesn't match is
// unredeemable, so we must NEVER build a t.me deep link from it — doing so
// sends the user `/start <badcode>` and the bot replies "invite link looks
// invalid". This guards against the placeholder default below, an empty value,
// or a stale code read from a deleted user doc.
final RegExp _kInviteCodePattern = RegExp(r'^VIVA-[A-Z0-9]{4}-[A-Z0-9]{2}$');

// LinkedIn sends us back to the redirect URI with ?error=… when the user backs
// out of the consent screen or it fails. Turn those raw OAuth codes into a
// human message. The cancel codes below are what LinkedIn / the OAuth spec emit
// when the user clicks "Cancel" rather than "Allow".
String _friendlyLinkedInError(String err, [String? desc]) {
  const cancelCodes = {
    'user_cancelled_login',
    'user_cancelled_authorize',
    'access_denied',
  };
  if (cancelCodes.contains(err)) {
    return 'No problem — LinkedIn sign-in was cancelled. '
        'Tap below whenever you’re ready to try again.';
  }
  final detail = (desc != null && desc.isNotEmpty) ? ' ($desc)' : '';
  return 'LinkedIn sign-in didn’t go through$detail. Tap below to try again.';
}

class WelcomeScreen extends StatefulWidget {
  const WelcomeScreen({
    super.key,
    this.userName = 'Léa',
    this.inviteCode = 'VIVA-26-LK7',
  });

  final String userName;
  final String inviteCode;

  @override
  State<WelcomeScreen> createState() => _WelcomeScreenState();
}

class _WelcomeScreenState extends State<WelcomeScreen> {
  bool _exchanging = false;
  String? _authError;
  late String _displayName;
  String? _email;
  String? _photoUrl;
  // The user's personal Telegram binding code (from linkedinSignIn / user doc).
  // Falls back to widget.inviteCode only if we can't resolve a real one.
  String? _telegramCode;
  // Set when the auth session is live but the users/{uid} doc is gone (e.g. the
  // account was deleted). The Telegram link can't be built, so we prompt a fresh
  // sign-in instead of handing out the broken placeholder code.
  bool _needsReauth = false;

  @override
  void initState() {
    super.initState();
    _displayName = widget.userName;

    final uri = Uri.base;
    final code = uri.queryParameters['code'];
    final ldErr = uri.queryParameters['error'];
    final ldErrDesc = uri.queryParameters['error_description'];

    // Strip ?code=…&state=… from the URL bar IMMEDIATELY so a page refresh
    // doesn't replay the (one-time-use) auth code and get a LinkedIn 400.
    // Done before any awaits to win the race against the user hitting refresh.
    if (kIsWeb && (code != null || ldErr != null)) {
      _stripAuthQuery();
    }

    if (ldErr != null) {
      _authError = _friendlyLinkedInError(ldErr, ldErrDesc);
      return;
    }

    // Already-signed-in path: refresh after a successful login, or arrived
    // here via top-bar nav. Skip the (now-stale) code exchange entirely.
    final existing = FirebaseAuth.instance.currentUser;
    if (existing != null) {
      _populateFromUser(existing);
      // Pull the real Telegram binding code from the user's doc.
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _loadTelegramCode(existing.uid),
      );
      return;
    }

    if (code != null && code.isNotEmpty) {
      _exchanging = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _exchange(code));
    }
  }

  Future<void> _loadTelegramCode(String uid) async {
    try {
      final snap = await FirebaseFirestore.instance.doc('users/$uid').get();
      if (!snap.exists) {
        // Auth session outlived the user doc (account deleted, or never
        // bootstrapped). Don't fall back to the placeholder code — that yields
        // a deep link the bot rejects. Prompt a fresh sign-in instead.
        if (mounted) setState(() => _needsReauth = true);
        return;
      }
      final code = snap.data()?['telegramLinkCode'] as String?;
      if (code != null && code.isNotEmpty && mounted) {
        setState(() => _telegramCode = code);
      }
    } catch (_) {
      // Non-fatal — leave the button disabled; its hint asks the user to retry.
    }
  }

  void _stripAuthQuery() {
    // Replace the URL in browser history without reloading the page —
    // keeps the /welcome path but drops the OAuth query params.
    try {
      web.window.history.replaceState(null, '', '/welcome');
    } catch (_) {
      // Older browsers / strange embeds — best-effort, OK to ignore.
    }
  }

  void _populateFromUser(User? user) {
    if (user == null) return;
    _displayName = user.displayName?.split(' ').first ?? widget.userName;
    _email = user.email;
    _photoUrl = user.photoURL;
  }

  Future<void> _exchange(String code) async {
    try {
      final uri = Uri.base;
      // Must byte-match the redirect_uri sent on the initial /authorization
      // request — invite_screen.dart now uses `${origin}/welcome`.
      final redirectUri = '${uri.origin}/welcome';

      final callable = FirebaseFunctions.instanceFor(
        region: 'europe-central2',
      ).httpsCallable('linkedinSignIn');
      final res = await callable.call(<String, String>{
        'code': code,
        'redirectUri': redirectUri,
      });

      final data = Map<String, dynamic>.from(res.data as Map);
      final token = data['customToken'] as String?;
      if (token == null) {
        if (!mounted) return;
        setState(() {
          _exchanging = false;
          _authError = 'No custom token returned.';
        });
        return;
      }

      // The function also returns the LinkedIn profile snapshot, used as the
      // first-paint identity if the FirebaseAuth user takes a moment to
      // settle after signInWithCustomToken.
      final profile = data['profile'] is Map
          ? Map<String, dynamic>.from(data['profile'] as Map)
          : const <String, dynamic>{};

      final telegramCode = data['telegramLinkCode'] as String?;

      final cred = await FirebaseAuth.instance.signInWithCustomToken(token);
      if (!mounted) return;
      setState(() {
        _exchanging = false;
        _populateFromUser(cred.user);
        // Fallbacks if FirebaseAuth user fields are unexpectedly empty.
        _email ??= profile['email'] as String?;
        _photoUrl ??= profile['picture'] as String?;
        if (_displayName == widget.userName) {
          final n = profile['name'] as String?;
          if (n != null && n.isNotEmpty) _displayName = n.split(' ').first;
        }
        if (telegramCode != null && telegramCode.isNotEmpty) {
          _telegramCode = telegramCode;
        }
      });
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() {
        _exchanging = false;
        _authError = 'Sign-in failed: ${e.message ?? e.code}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _exchanging = false;
        _authError = 'Sign-in failed: $e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_exchanging) {
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                width: 28,
                height: 28,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: AppColors.accent,
                ),
              ),
              SizedBox(height: 16),
              Text(
                'Signing you in…',
                style: TextStyle(color: AppColors.inkMuted, fontSize: 14),
              ),
            ],
          ),
        ),
      );
    }
    if (_authError != null) {
      return Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _authError!,
                  style: const TextStyle(color: Colors.red, fontSize: 14),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 24),
                TextButton(
                  onPressed: () =>
                      Navigator.of(context).pushReplacementNamed('/in'),
                  child: const Text('Back to sign in'),
                ),
              ],
            ),
          ),
        ),
      );
    }

    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;

    return AppScaffold(
      // Identity is already shown in the WELCOME, <name> block below, so we
      // deliberately leave the top-bar trailing slot empty to avoid showing
      // the user's name/avatar twice.
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: isCompact ? 24 : 48),
          child: isCompact
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _WelcomeBlock(
                      userName: _displayName,
                      email: _email,
                      photoUrl: _photoUrl,
                      inviteCode: _telegramCode ?? widget.inviteCode,
                      needsReauth: _needsReauth,
                    ),
                    const SizedBox(height: 56),
                    const _MatchedHumansBlock(),
                  ],
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: _WelcomeBlock(
                        userName: _displayName,
                        email: _email,
                        photoUrl: _photoUrl,
                        inviteCode: _telegramCode ?? widget.inviteCode,
                        needsReauth: _needsReauth,
                      ),
                    ),
                    const SizedBox(width: 48),
                    const Expanded(child: _MatchedHumansBlock()),
                  ],
                ),
        ),
      ),
    );
  }
}

class _WelcomeBlock extends StatelessWidget {
  const _WelcomeBlock({
    required this.userName,
    required this.inviteCode,
    this.email,
    this.photoUrl,
    this.needsReauth = false,
  });

  final String userName;
  final String inviteCode;
  final String? email;
  final String? photoUrl;
  // True when we know the account doc is gone — show a re-sign-in prompt rather
  // than a (still-loading) "preparing your link" hint.
  final bool needsReauth;

  Future<void> _open(Uri url) async {
    await openLink(url);
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;
    final titleSize = (width * (isCompact ? 0.13 : 0.066)).clamp(46.0, 88.0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            if (photoUrl != null && photoUrl!.isNotEmpty) ...[
              ClipOval(
                child: Image.network(
                  photoUrl!,
                  width: 36,
                  height: 36,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) =>
                      _AvatarFallback(name: userName, size: 36),
                ),
              ),
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'WELCOME, ${userName.toUpperCase()}',
                    style: const TextStyle(
                      fontSize: 11,
                      letterSpacing: 1.4,
                      color: AppColors.inkMuted,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (email != null && email!.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      email!,
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.inkSubtle,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 24),
        RichText(
          text: TextSpan(
            style: serif(fontSize: titleSize, weight: FontWeight.w500),
            children: [
              const TextSpan(text: 'Welcome to\n'),
              TextSpan(
                text: 'Viva Tribe',
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
        const SizedBox(height: 24),
        Text(
          'One last move. The next three days live on Telegram.',
          style: TextStyle(
            color: AppColors.inkMuted,
            fontSize: isCompact ? 15 : 16,
            height: 1.5,
          ),
        ),
        const SizedBox(height: 28),
        // Only enable the CTA once we hold a real, redeemable code. A malformed
        // value (the placeholder default, an empty string, or a stale read)
        // would build a t.me link the bot rejects, so we disable instead.
        if (_kInviteCodePattern.hasMatch(inviteCode))
          TelegramJoinButton(
            onPressed: () => _open(ChannelLinks.telegramJoin(inviteCode)),
            fullWidth: isCompact,
          )
        else ...[
          TelegramJoinButton(onPressed: null, fullWidth: isCompact),
          const SizedBox(height: 10),
          if (needsReauth)
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Flexible(
                  child: Text(
                    "We couldn't find your account.",
                    style: TextStyle(color: AppColors.inkMuted, fontSize: 13),
                  ),
                ),
                TextButton(
                  onPressed: () =>
                      Navigator.of(context).pushReplacementNamed('/in'),
                  child: const Text('Sign in again'),
                ),
              ],
            )
          else
            const Text(
              'Preparing your Telegram link…',
              style: TextStyle(color: AppColors.inkMuted, fontSize: 13),
            ),
        ],
        const SizedBox(height: 14),
        Row(
          children: [
            WhatsAppSecondaryButton(
              onPressed: () => _open(ChannelLinks.whatsAppJoin()),
            ),
            const SizedBox(width: 10),
            const Text(
              'fallback',
              style: TextStyle(
                color: AppColors.inkSubtle,
                fontSize: 11,
                fontStyle: FontStyle.italic,
              ),
            ),
          ],
        ),
        const SizedBox(height: 40),
        const Text(
          "YOU'LL SEE THEM TOGETHER",
          style: TextStyle(
            fontSize: 11,
            letterSpacing: 1.4,
            color: AppColors.inkMuted,
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 14),
        SizedBox(
          height: 116,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            padding: EdgeInsets.zero,
            itemCount: sampleSpeakers.length,
            separatorBuilder: (_, _) => const SizedBox(width: 10),
            itemBuilder: (_, i) => MiniSpeakerCard(speaker: sampleSpeakers[i]),
          ),
        ),
      ],
    );
  }
}

class _AvatarFallback extends StatelessWidget {
  const _AvatarFallback({required this.name, this.size = 36});

  final String name;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        color: AppColors.accentSoft,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        name.isEmpty ? '?' : name.characters.first.toUpperCase(),
        style: TextStyle(
          color: AppColors.ink,
          fontWeight: FontWeight.w600,
          fontSize: size * 0.42,
        ),
      ),
    );
  }
}

class _MatchedHumansBlock extends StatelessWidget {
  const _MatchedHumansBlock();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 540;
    final stream = FirebaseFirestore.instance
        .collection('events')
        .where('status', whereIn: ['scheduled', 'live'])
        .orderBy('startAt')
        .limit(6)
        .snapshots();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
          stream: stream,
          builder: (context, snap) {
            final docs = snap.data?.docs ?? const [];

            final headerRow = Row(
              children: [
                const Flexible(
                  child: Text(
                    'UPCOMING EVENTS',
                    style: TextStyle(
                      fontSize: 11,
                      letterSpacing: 1.4,
                      color: AppColors.inkMuted,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                const Spacer(),
                if (docs.isNotEmpty)
                  StatusPill(label: '${docs.length} scheduled'),
              ],
            );

            Widget body;
            if (snap.connectionState == ConnectionState.waiting) {
              body = const _EventsPlaceholder(
                text: 'Loading events…',
                showSpinner: true,
              );
            } else if (snap.hasError) {
              body = _EventsPlaceholder(
                text: 'Couldn\'t load events: ${snap.error}',
                error: true,
              );
            } else if (docs.isEmpty) {
              body = const _EventsPlaceholder(
                text:
                    'Nothing on the calendar yet. Members propose events by texting `create event` to the Tribu bot on Telegram or WhatsApp.',
              );
            } else {
              body = Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var i = 0; i < docs.length; i++) ...[
                    _EventRow(index: i + 1, doc: docs[i]),
                    if (i < docs.length - 1) const SizedBox(height: 10),
                  ],
                ],
              );
            }

            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (isCompact) headerRow else headerRow,
                const SizedBox(height: 18),
                body,
              ],
            );
          },
        ),
      ],
    );
  }
}

class _EventRow extends StatelessWidget {
  const _EventRow({required this.index, required this.doc});

  final int index;
  final QueryDocumentSnapshot<Map<String, dynamic>> doc;

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

  @override
  Widget build(BuildContext context) {
    final d = doc.data();
    final kind = (d['kind'] as String?) ?? 'other';
    final title = (d['title'] as String?) ?? '(untitled)';
    final hostName = (d['hostName'] as String?) ?? 'A member';
    final neighborhood = (d['addressNeighborhood'] as String?) ?? '';
    final addressFull = (d['addressFull'] as String?) ?? '';
    final startAt = d['startAt'];
    final when = startAt is Timestamp ? _formatParis(startAt.toDate()) : '';
    final emoji = _emojiByKind[kind] ?? '📍';
    final placeBits = [
      addressFull.isNotEmpty ? addressFull : neighborhood,
      'hosted by $hostName',
    ].where((s) => s.isNotEmpty).join(' · ');

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        border: Border.all(color: AppColors.cardBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          SizedBox(
            width: 24,
            child: Text(
              index.toString().padLeft(2, '0'),
              style: mono(
                fontSize: 11,
                color: AppColors.inkSubtle,
                weight: FontWeight.w500,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Container(
            width: 38,
            height: 38,
            decoration: const BoxDecoration(
              color: AppColors.accentSoft,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Text(emoji, style: const TextStyle(fontSize: 18)),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 10,
                  runSpacing: 2,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppColors.ink,
                      ),
                    ),
                    if (when.isNotEmpty)
                      Text(
                        when.toUpperCase(),
                        style: const TextStyle(
                          fontSize: 10,
                          color: AppColors.inkSubtle,
                          letterSpacing: 1.3,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                  ],
                ),
                if (placeBits.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    placeBits,
                    style: serif(
                      fontSize: 14,
                      weight: FontWeight.w400,
                      style: FontStyle.italic,
                      color: AppColors.inkMuted,
                      height: 1.3,
                      letterSpacing: -0.1,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _formatParis(DateTime dt) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    final l = dt.toLocal();
    final dn = days[(l.weekday - 1).clamp(0, 6)];
    final mn = months[(l.month - 1).clamp(0, 11)];
    final hh = l.hour.toString().padLeft(2, '0');
    final mm = l.minute.toString().padLeft(2, '0');
    return '$dn ${l.day} $mn · $hh:$mm';
  }
}

class _EventsPlaceholder extends StatelessWidget {
  const _EventsPlaceholder({
    required this.text,
    this.showSpinner = false,
    this.error = false,
  });

  final String text;
  final bool showSpinner;
  final bool error;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 24),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        border: Border.all(color: AppColors.cardBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          if (showSpinner) ...[
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.accent,
              ),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(
            child: Text(
              text,
              style: TextStyle(
                color: error ? Colors.red : AppColors.inkMuted,
                fontSize: 13,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
