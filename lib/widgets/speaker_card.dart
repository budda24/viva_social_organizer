import 'package:flutter/material.dart';

import '../models/speaker.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

class SpeakerCard extends StatelessWidget {
  const SpeakerCard({super.key, required this.speaker});

  final Speaker speaker;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.cardBorder),
      ),
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(8),
              child: speaker.imageUrl != null
                  ? Image.asset(
                      speaker.imageUrl!,
                      fit: BoxFit.cover,
                      alignment: Alignment.topCenter,
                    )
                  : Container(
                      color: AppColors.surfaceTint,
                      alignment: Alignment.center,
                      padding: const EdgeInsets.all(8),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.image_outlined,
                            color: AppColors.inkSubtle,
                            size: 22,
                          ),
                          const SizedBox(height: 6),
                          Text(
                            'portrait · ${speaker.name}',
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 11,
                              color: AppColors.inkSubtle,
                            ),
                          ),
                        ],
                      ),
                    ),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            speaker.name,
            style: serif(fontSize: 20, weight: FontWeight.w500),
          ),
          const SizedBox(height: 4),
          Text(
            speaker.role,
            style: const TextStyle(
              fontSize: 11,
              letterSpacing: 1.3,
              color: AppColors.inkMuted,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
