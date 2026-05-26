import 'package:flutter/material.dart';

import '../models/attendee.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

class AttendeeCard extends StatelessWidget {
  const AttendeeCard({super.key, required this.attendee});

  final Attendee attendee;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        border: Border.all(color: AppColors.cardBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 46,
            height: 46,
            decoration: const BoxDecoration(
              color: AppColors.accentSoft,
              shape: BoxShape.circle,
            ),
            alignment: Alignment.center,
            child: Text(
              attendee.name.characters.first,
              style: const TextStyle(
                color: AppColors.ink,
                fontWeight: FontWeight.w600,
                fontSize: 18,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            attendee.name,
            style: serif(fontSize: 19, weight: FontWeight.w500),
          ),
          const SizedBox(height: 4),
          Text(
            attendee.description,
            style: const TextStyle(
              color: AppColors.inkMuted,
              fontSize: 13,
              fontStyle: FontStyle.italic,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            attendee.location,
            style: const TextStyle(
              color: AppColors.inkSubtle,
              fontSize: 10,
              letterSpacing: 1.4,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
