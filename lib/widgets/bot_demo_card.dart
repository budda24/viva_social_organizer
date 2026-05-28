import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// One "phone mockup" card on the landing page showing a short bot exchange.
/// Static illustration — not interactive — so it stays cheap and reliable.
class BotDemoCard extends StatelessWidget {
  const BotDemoCard({
    super.key,
    required this.kicker,
    required this.title,
    required this.turns,
    required this.caption,
  });

  /// Small label above the title (e.g. `01 · FIND PEOPLE`).
  final String kicker;

  /// Demo title (e.g. `Find people`).
  final String title;

  /// Ordered list of chat turns rendered inside the phone frame.
  final List<DemoTurn> turns;

  /// One-line caption shown beneath the phone (explains what the demo proves).
  final String caption;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          kicker,
          style: const TextStyle(
            fontSize: 10,
            letterSpacing: 1.4,
            fontWeight: FontWeight.w600,
            color: AppColors.inkSubtle,
          ),
        ),
        const SizedBox(height: 6),
        Text(
          title,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: AppColors.ink,
          ),
        ),
        const SizedBox(height: 14),
        Container(
          decoration: BoxDecoration(
            color: AppColors.cardBg,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(color: AppColors.cardBorder),
          ),
          padding: const EdgeInsets.fromLTRB(14, 14, 14, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _BotHeader(),
              const SizedBox(height: 12),
              for (final t in turns) ...[
                _Bubble(turn: t),
                const SizedBox(height: 8),
              ],
            ],
          ),
        ),
        const SizedBox(height: 10),
        Text(
          caption,
          style: const TextStyle(
            fontSize: 12,
            color: AppColors.inkMuted,
            height: 1.45,
          ),
        ),
      ],
    );
  }
}

/// A single turn in a demo conversation. `fromUser=false` means the bot is
/// speaking; the bubble flips alignment and color accordingly.
class DemoTurn {
  const DemoTurn({
    required this.text,
    required this.fromUser,
    this.time = '',
  });

  final String text;
  final bool fromUser;
  final String time;
}

class _BotHeader extends StatelessWidget {
  const _BotHeader();

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 26,
          height: 26,
          decoration: const BoxDecoration(
            color: AppColors.accentSoft,
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: const Icon(Icons.bolt, size: 14, color: AppColors.accent),
        ),
        const SizedBox(width: 10),
        const Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'VivaTribuBot',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.ink,
              ),
            ),
            SizedBox(height: 1),
            Row(
              children: [
                Icon(Icons.circle, size: 7, color: AppColors.statusGreen),
                SizedBox(width: 5),
                Text(
                  'bot · online',
                  style: TextStyle(fontSize: 10, color: AppColors.inkMuted),
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble({required this.turn});

  final DemoTurn turn;

  @override
  Widget build(BuildContext context) {
    final bg = turn.fromUser
        ? AppColors.accentSoft
        : AppColors.surfaceTint;
    final align = turn.fromUser
        ? CrossAxisAlignment.end
        : CrossAxisAlignment.start;
    return Column(
      crossAxisAlignment: align,
      children: [
        Container(
          constraints: const BoxConstraints(maxWidth: 240),
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: AppColors.cardBorder),
          ),
          child: Text(
            turn.text,
            style: const TextStyle(
              fontSize: 12.5,
              height: 1.4,
              color: AppColors.ink,
            ),
          ),
        ),
        if (turn.time.isNotEmpty) ...[
          const SizedBox(height: 3),
          Text(
            turn.time,
            style: const TextStyle(fontSize: 9.5, color: AppColors.inkSubtle),
          ),
        ],
      ],
    );
  }
}
