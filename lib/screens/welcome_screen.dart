import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../config/channel_links.dart';
import '../data/sample_data.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';
import '../widgets/chat_buttons.dart';
import '../widgets/matched_human_row.dart';
import '../widgets/mini_speaker_card.dart';
import '../widgets/status_pill.dart';
import '../widgets/user_avatar_chip.dart';

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

  @override
  void initState() {
    super.initState();
    _displayName = widget.userName;

    final uri = Uri.base;
    final code = uri.queryParameters['code'];
    final ldErr = uri.queryParameters['error'];

    if (ldErr != null) {
      _authError = 'LinkedIn returned $ldErr';
      return;
    }
    if (code != null && code.isNotEmpty) {
      _exchanging = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _exchange(code));
    } else {
      // No code — check existing Firebase Auth session
      final user = FirebaseAuth.instance.currentUser;
      if (user != null) {
        _displayName = user.displayName?.split(' ').first ?? widget.userName;
      }
    }
  }

  Future<void> _exchange(String code) async {
    try {
      final uri = Uri.base;
      // Must byte-match the redirect_uri sent on the initial /authorization
      // request — invite_screen.dart now uses `${origin}/welcome`.
      final redirectUri = '${uri.origin}/welcome';

      final callable = FirebaseFunctions.instanceFor(region: 'europe-central2')
          .httpsCallable('linkedinSignIn');
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

      final cred = await FirebaseAuth.instance.signInWithCustomToken(token);
      if (!mounted) return;
      setState(() {
        _exchanging = false;
        _displayName = cred.user?.displayName?.split(' ').first ?? widget.userName;
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
                child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.accent),
              ),
              SizedBox(height: 16),
              Text('Signing you in…',
                  style: TextStyle(color: AppColors.inkMuted, fontSize: 14)),
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
      topBarTrailing: UserAvatarChip(name: _displayName),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: isCompact ? 24 : 48),
          child: isCompact
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _WelcomeBlock(userName: _displayName, inviteCode: widget.inviteCode),
                    const SizedBox(height: 56),
                    const _MatchedHumansBlock(),
                  ],
                )
              : Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: _WelcomeBlock(userName: _displayName, inviteCode: widget.inviteCode)),
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
  const _WelcomeBlock({required this.userName, required this.inviteCode});

  final String userName;
  final String inviteCode;

  Future<void> _open(Uri url) async {
    await launchUrl(url, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;
    final titleSize =
        (width * (isCompact ? 0.13 : 0.066)).clamp(46.0, 88.0);

    return Column(
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
        TelegramJoinButton(
          onPressed: () => _open(ChannelLinks.telegramJoin(inviteCode)),
          fullWidth: isCompact,
        ),
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

class _MatchedHumansBlock extends StatelessWidget {
  const _MatchedHumansBlock();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 540;

    final header = Row(
      children: const [
        Flexible(
          child: Text(
            'YOUR FIRST 5 HUMANS',
            style: TextStyle(
              fontSize: 11,
              letterSpacing: 1.4,
              color: AppColors.inkMuted,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
        SizedBox(width: 12),
        _AiMatchedChip(),
        Spacer(),
        StatusPill(label: '4 free now'),
      ],
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (isCompact)
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: const [
                  Text(
                    'YOUR FIRST 5 HUMANS',
                    style: TextStyle(
                      fontSize: 11,
                      letterSpacing: 1.4,
                      color: AppColors.inkMuted,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  SizedBox(width: 10),
                  _AiMatchedChip(),
                  Spacer(),
                ],
              ),
              const SizedBox(height: 8),
              const StatusPill(label: '4 free now'),
            ],
          )
        else
          header,
        const SizedBox(height: 18),
        for (var i = 0; i < sampleMatchedHumans.length; i++) ...[
          MatchedHumanRow(index: i + 1, human: sampleMatchedHumans[i]),
          if (i < sampleMatchedHumans.length - 1) const SizedBox(height: 10),
        ],
      ],
    );
  }
}

class _AiMatchedChip extends StatelessWidget {
  const _AiMatchedChip();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: AppColors.accentSoft,
        borderRadius: BorderRadius.circular(999),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.auto_awesome, color: AppColors.accent, size: 11),
          SizedBox(width: 6),
          Text(
            'AI-MATCHED',
            style: TextStyle(
              fontSize: 10,
              letterSpacing: 1.3,
              color: AppColors.accent,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
