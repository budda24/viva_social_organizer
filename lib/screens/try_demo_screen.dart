import 'package:flutter/material.dart';

import '../config/channel_links.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../utils/open_link.dart';
import '../widgets/brand_logos.dart';
import '../widgets/primary_button.dart';
import 'landing_screen.dart';

/// Channel chooser for the live demo. The landing "Try the live demo" CTA lands
/// here so a prospect picks where to chat with the concierge. Telegram is the
/// emphasized, one-tap path; WhatsApp runs through the Twilio sandbox, which
/// needs a quick `join` opt-in first — so it's framed as the secondary option.
class TryDemoScreen extends StatelessWidget {
  const TryDemoScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 560;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(-0.6, -0.7),
            radius: 1.4,
            colors: [AppColors.backgroundGlow, AppColors.background],
            stops: [0.0, 0.55],
          ),
        ),
        child: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: EdgeInsets.symmetric(
                horizontal: isCompact ? 20 : 32,
                vertical: 28,
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 540),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        onPressed: () {
                          if (Navigator.of(context).canPop()) {
                            Navigator.of(context).pop();
                          } else {
                            Navigator.of(context).pushReplacementNamed('/');
                          }
                        },
                        icon: const Icon(Icons.arrow_back, size: 16),
                        label: const Text('Back'),
                        style: TextButton.styleFrom(
                          foregroundColor: AppColors.inkMuted,
                          textStyle: const TextStyle(
                              fontSize: 13, fontWeight: FontWeight.w500),
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    const _BrandRow(),
                    const SizedBox(height: 26),
                    Text(
                      'Try the live demo',
                      style: serif(
                        fontSize: isCompact ? 32 : 40,
                        weight: FontWeight.w500,
                        height: 1.05,
                      ),
                    ),
                    const SizedBox(height: 12),
                    Text(
                      "You'll chat with the real concierge in a sandbox — sample "
                      "attendees, sample events, nothing real, so explore freely. "
                      'Pick where to start:',
                      style: TextStyle(
                        fontSize: isCompact ? 14 : 15.5,
                        height: 1.5,
                        color: AppColors.inkMuted,
                      ),
                    ),
                    const SizedBox(height: 28),
                    _ChannelCard(
                      logo: const TelegramLogo(size: 30),
                      title: 'Telegram',
                      subtitle: 'One tap — opens the bot and drops you straight in.',
                      tag: 'RECOMMENDED',
                      buttonLabel: 'Open in Telegram',
                      primary: true,
                      onTap: () => openLink(Uri.parse(LandingScreen.tryDemoUrl)),
                    ),
                    const SizedBox(height: 14),
                    _ChannelCard(
                      logo: const WhatsAppLogo(size: 30),
                      title: 'WhatsApp',
                      subtitle: 'Runs on the Twilio sandbox, so it needs a quick '
                          'opt-in: tap below to send the pre-filled “join” message, '
                          'then send any message (“hi”) and I’ll drop you in.',
                      tag: 'SANDBOX',
                      buttonLabel: 'Open in WhatsApp',
                      primary: false,
                      onTap: () => openLink(ChannelLinks.whatsAppJoin()),
                    ),
                    const SizedBox(height: 22),
                    Center(
                      child: TextButton(
                        onPressed: () =>
                            openLink(Uri.parse(LandingScreen.calendlyUrl)),
                        style: TextButton.styleFrom(
                          foregroundColor: AppColors.inkMuted,
                          textStyle: const TextStyle(
                              fontSize: 13.5, fontWeight: FontWeight.w500),
                        ),
                        child: const Text('or book a demo call →'),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BrandRow extends StatelessWidget {
  const _BrandRow();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(9),
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [AppColors.accent, Color(0xFF7C5CE0)],
            ),
          ),
          alignment: Alignment.center,
          child: const Icon(Icons.hub, size: 16, color: AppColors.accentInk),
        ),
        const SizedBox(width: 10),
        Text(
          LandingScreen.product,
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            fontSize: 16,
            color: AppColors.ink,
            letterSpacing: -0.2,
          ),
        ),
      ],
    );
  }
}

/// One channel option. [primary] gives it the accent border + filled button
/// (Telegram); otherwise a muted border + outlined button (WhatsApp sandbox).
class _ChannelCard extends StatelessWidget {
  const _ChannelCard({
    required this.logo,
    required this.title,
    required this.subtitle,
    required this.tag,
    required this.buttonLabel,
    required this.primary,
    required this.onTap,
  });

  final Widget logo;
  final String title;
  final String subtitle;
  final String tag;
  final String buttonLabel;
  final bool primary;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: primary ? AppColors.accent : AppColors.cardBorder,
        ),
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              logo,
              const SizedBox(width: 12),
              Text(
                title,
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w700,
                  color: AppColors.ink,
                ),
              ),
              const Spacer(),
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                decoration: BoxDecoration(
                  color: AppColors.accentSoft,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  tag,
                  style: const TextStyle(
                    fontSize: 9,
                    letterSpacing: 1.0,
                    fontWeight: FontWeight.w700,
                    color: AppColors.accent,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            subtitle,
            style: const TextStyle(
              fontSize: 13.5,
              height: 1.5,
              color: AppColors.inkMuted,
            ),
          ),
          const SizedBox(height: 16),
          if (primary)
            PrimaryButton(
              label: buttonLabel,
              fullWidth: true,
              onPressed: onTap,
            )
          else
            _OutlinedAction(label: buttonLabel, onTap: onTap),
        ],
      ),
    );
  }
}

/// Full-width outlined button — the de-emphasized counterpart to PrimaryButton,
/// used for the secondary (WhatsApp) channel.
class _OutlinedAction extends StatelessWidget {
  const _OutlinedAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(vertical: 14),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: AppColors.accent),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                label,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w600,
                  color: AppColors.accent,
                ),
              ),
              const SizedBox(width: 10),
              const Icon(Icons.arrow_forward, size: 18, color: AppColors.accent),
            ],
          ),
        ),
      ),
    );
  }
}
