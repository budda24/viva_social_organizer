import 'package:flutter/material.dart';

import '../models/matched_human.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

class MatchedHumanRow extends StatelessWidget {
  const MatchedHumanRow({super.key, required this.index, required this.human});

  final int index;
  final MatchedHuman human;

  @override
  Widget build(BuildContext context) {
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
            child: Text(
              human.name.characters.first,
              style: const TextStyle(
                color: AppColors.ink,
                fontWeight: FontWeight.w600,
                fontSize: 14,
              ),
            ),
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
                      human.name,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                        color: AppColors.ink,
                      ),
                    ),
                    Text(
                      human.city,
                      style: const TextStyle(
                        fontSize: 10,
                        color: AppColors.inkSubtle,
                        letterSpacing: 1.3,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  human.description,
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
            ),
          ),
        ],
      ),
    );
  }
}
