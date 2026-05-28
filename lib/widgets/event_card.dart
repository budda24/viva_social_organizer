import 'dart:ui';

import 'package:flutter/material.dart';

import '../models/event.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';

class EventCard extends StatelessWidget {
  const EventCard({super.key, required this.event});

  final Event event;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        border: Border.all(color: AppColors.cardBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(event.emoji, style: const TextStyle(fontSize: 26)),
          const SizedBox(height: 12),
          Text(
            event.title,
            style: serif(fontSize: 17, weight: FontWeight.w500),
          ),
          const SizedBox(height: 12),
          Stack(
            children: [
              ImageFiltered(
                imageFilter: ImageFilter.blur(sigmaX: 4.5, sigmaY: 4.5),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _OrganizerRow(name: event.organizer),
                    const SizedBox(height: 10),
                    Text(
                      event.day,
                      style: const TextStyle(
                        color: AppColors.inkSubtle,
                        fontSize: 10,
                        letterSpacing: 1.4,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Positioned.fill(
                child: Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.surfaceTint,
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(color: AppColors.surfaceTintBorder),
                    ),
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.lock_outline,
                          size: 11,
                          color: AppColors.accent,
                        ),
                        SizedBox(width: 6),
                        Text(
                          'Sign in for when & host',
                          style: TextStyle(
                            color: AppColors.ink,
                            fontSize: 10,
                            letterSpacing: 0.6,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _OrganizerRow extends StatelessWidget {
  const _OrganizerRow({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 20,
          height: 20,
          decoration: const BoxDecoration(
            color: AppColors.accentSoft,
            shape: BoxShape.circle,
          ),
          alignment: Alignment.center,
          child: Text(
            name.characters.first,
            style: const TextStyle(
              color: AppColors.ink,
              fontWeight: FontWeight.w600,
              fontSize: 11,
            ),
          ),
        ),
        const SizedBox(width: 8),
        Flexible(
          child: Text(
            name,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              color: AppColors.inkMuted,
              fontSize: 12,
              fontStyle: FontStyle.italic,
            ),
          ),
        ),
      ],
    );
  }
}
