import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

class _Brand {
  static const Color telegram = Color(0xFF229ED9);
  static const Color telegramTint = Color(0x33FFFFFF);
  static const Color whatsApp = Color(0xFF25D366);
}

/// Primary CTA — large, branded for Telegram (the channel we're pushing).
class TelegramJoinButton extends StatelessWidget {
  const TelegramJoinButton({
    super.key,
    required this.onPressed,
    this.label = 'Join the tribe on Telegram',
    this.fullWidth = false,
  });

  final VoidCallback? onPressed;
  final String label;
  final bool fullWidth;

  @override
  Widget build(BuildContext context) {
    final button = Material(
      color: _Brand.telegram,
      borderRadius: BorderRadius.circular(16),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: onPressed,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 20),
          child: Row(
            mainAxisSize: fullWidth ? MainAxisSize.max : MainAxisSize.min,
            children: [
              Container(
                width: 32,
                height: 32,
                decoration: const BoxDecoration(
                  color: _Brand.telegramTint,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: const Icon(Icons.send_rounded,
                    color: Colors.white, size: 16),
              ),
              const SizedBox(width: 14),
              Text(
                label,
                style: const TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w600,
                  fontSize: 17,
                ),
              ),
              if (fullWidth) const Spacer() else const SizedBox(width: 14),
              const Icon(Icons.arrow_forward, color: Colors.white, size: 20),
            ],
          ),
        ),
      ),
    );
    return fullWidth ? SizedBox(width: double.infinity, child: button) : button;
  }
}

/// Secondary, intentionally small — fallback for users who insist on WhatsApp.
class WhatsAppSecondaryButton extends StatelessWidget {
  const WhatsAppSecondaryButton({
    super.key,
    required this.onPressed,
    this.label = 'Prefer WhatsApp',
  });

  final VoidCallback? onPressed;
  final String label;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onPressed,
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
              Container(
                width: 16,
                height: 16,
                decoration: const BoxDecoration(
                  color: _Brand.whatsApp,
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: const Icon(Icons.chat_bubble_rounded,
                    color: Colors.white, size: 9),
              ),
              const SizedBox(width: 8),
              Text(
                label,
                style: const TextStyle(
                  color: AppColors.ink,
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
