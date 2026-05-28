import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../theme/app_colors.dart';
import 'online_tribes_logo.dart';

class AppFooter extends StatelessWidget {
  const AppFooter({super.key});

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    final children = <Widget>[
      Row(
        mainAxisSize: MainAxisSize.min,
        children: const [
          OnlineTribesLogo(size: 18),
          SizedBox(width: 10),
          Flexible(
            child: Text(
              'A Viva Tribe gathering · powered by Online Tribes',
              style: TextStyle(fontSize: 12, color: AppColors.inkMuted),
            ),
          ),
        ],
      ),
      MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () => launchUrl(
            Uri.parse('mailto:franek@online-tribes.com'),
            mode: LaunchMode.externalApplication,
          ),
          child: const Text(
            'franek@online-tribes.com',
            style: TextStyle(
              fontSize: 12,
              color: AppColors.inkMuted,
              decoration: TextDecoration.underline,
              decorationColor: AppColors.inkSubtle,
            ),
          ),
        ),
      ),
    ];

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: isCompact ? 20 : 40,
        vertical: 28,
      ),
      child: isCompact
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                children[0],
                const SizedBox(height: 12),
                children[1],
              ],
            )
          : Row(
              children: [children[0], const Spacer(), children[1]],
            ),
    );
  }
}
