import 'package:flutter/material.dart';

import '../models/speaker.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

class MiniSpeakerCard extends StatelessWidget {
  const MiniSpeakerCard({super.key, required this.speaker});

  final Speaker speaker;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 92,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            height: 72,
            decoration: BoxDecoration(
              color: AppColors.cardBg,
              border: Border.all(color: AppColors.cardBorder),
              borderRadius: BorderRadius.circular(8),
            ),
            padding: const EdgeInsets.all(6),
            alignment: Alignment.center,
            child: Text(
              speaker.name,
              textAlign: TextAlign.center,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 9,
                color: AppColors.inkSubtle,
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            speaker.name,
            style: serif(fontSize: 12, weight: FontWeight.w500),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
