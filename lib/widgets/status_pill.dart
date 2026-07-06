import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

class StatusPill extends StatelessWidget {
  const StatusPill({super.key, required this.label, this.dotColor = AppColors.statusGreen});

  final String label;
  final Color dotColor;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          // Nudge the dot down to sit on the first text line when the label
          // wraps to multiple lines on narrow screens.
          margin: const EdgeInsets.only(top: 4),
          width: 7,
          height: 7,
          decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
        ),
        const SizedBox(width: 8),
        // Flexible so a long label (e.g. "No app to download · WhatsApp &
        // Telegram · your branding") wraps within the screen instead of being
        // clipped at the edge on mobile (QA: "merge text hides on phone").
        Flexible(
          child: Text(
            label,
            style: const TextStyle(
              fontSize: 12,
              color: AppColors.inkMuted,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ],
    );
  }
}
