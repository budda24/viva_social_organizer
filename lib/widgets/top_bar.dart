import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import 'online_tribes_logo.dart';

class TopBar extends StatelessWidget {
  const TopBar({super.key, this.trailing});

  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: isCompact ? 20 : 40,
        vertical: 24,
      ),
      child: Row(
        children: [
          const OnlineTribesLogo(),
          const SizedBox(width: 10),
          const Text(
            'Online Tribes',
            style: TextStyle(
              fontWeight: FontWeight.w600,
              fontSize: 15,
              color: AppColors.ink,
            ),
          ),
          if (!isCompact) ...[
            const SizedBox(width: 20),
            Container(width: 1, height: 18, color: AppColors.divider),
            const SizedBox(width: 20),
            const Text(
              'VIVA TRIBE  ·  17-20 JUNE 2026',
              style: TextStyle(
                fontSize: 11,
                letterSpacing: 1.3,
                color: AppColors.inkMuted,
                fontWeight: FontWeight.w500,
              ),
            ),
          ],
          const Spacer(),
          ?trailing,
        ],
      ),
    );
  }
}
