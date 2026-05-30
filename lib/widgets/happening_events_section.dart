import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../models/event.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import 'event_card.dart';
import 'status_pill.dart';

/// Firestore-backed "ALREADY HAPPENING" teaser: a grid of gated (blurred)
/// event cards driven by the public `events` collection. Shared by the
/// pre-auth landing page (above the speakers) and the /in sign-in screen to
/// drive conversion. Falls back to a "be first" empty state when nothing is
/// scheduled yet.
class HappeningEventsSection extends StatelessWidget {
  const HappeningEventsSection({super.key});

  static const _emojiByKind = {
    'breakfast': '🍳',
    'coffee': '☕',
    'lunch': '🥗',
    'drinks': '🥂',
    'dinner': '🍝',
    'rooftop': '🌇',
    'walk': '🚶',
    'side-event': '🎟️',
    'other': '📍',
  };

  static const _days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  static const _months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];

  static String _dayLabel(DateTime dt) {
    final l = dt.toLocal();
    final dn = _days[(l.weekday - 1).clamp(0, 6)];
    final mn = _months[(l.month - 1).clamp(0, 11)];
    return '$dn · ${l.day} $mn';
  }

  Event _fromDoc(QueryDocumentSnapshot<Map<String, dynamic>> doc) {
    final d = doc.data();
    final kind = (d['kind'] as String?) ?? 'other';
    final title = (d['title'] as String?) ?? '(untitled)';
    final hostName = (d['hostName'] as String?) ?? 'A member';
    final startAt = d['startAt'];
    final day = startAt is Timestamp ? _dayLabel(startAt.toDate()) : '';
    final emoji = _emojiByKind[kind] ?? '📍';
    return Event(
      emoji: emoji,
      title: title,
      day: day,
      organizer: hostName,
    );
  }

  @override
  Widget build(BuildContext context) {
    final stream = FirebaseFirestore.instance
        .collection('events')
        .where('status', whereIn: ['scheduled', 'live'])
        .orderBy('startAt')
        .limit(12)
        .snapshots();

    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: stream,
      builder: (context, snap) {
        // Don't render anything until the first snapshot resolves — avoids
        // flashing the "be first" empty state on a cold load that's about to
        // populate. Firestore's offline cache makes this near-instant on
        // warm loads.
        if (snap.connectionState == ConnectionState.waiting) {
          return const SizedBox.shrink();
        }
        final events = (snap.data?.docs ?? const [])
            .map(_fromDoc)
            .toList(growable: false);
        final isEmpty = events.isEmpty;

        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text(
                  'ALREADY HAPPENING',
                  style: TextStyle(
                    color: AppColors.inkMuted,
                    fontSize: 11,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const Spacer(),
                StatusPill(
                  label: isEmpty
                      ? 'Nobody yet · be first'
                      : '${events.length} live · sign in for details',
                ),
              ],
            ),
            const SizedBox(height: 18),
            if (isEmpty)
              const _EmptyHappeningState(example: _exampleEvent)
            else
              LayoutBuilder(
                builder: (context, constraints) {
                  final w = constraints.maxWidth;
                  final columns = w < 460
                      ? 2
                      : w < 720
                      ? 3
                      : w < 1000
                      ? 4
                      : 5;
                  const gap = 12.0;
                  final cardWidth =
                      (constraints.maxWidth - gap * (columns - 1)) / columns;
                  return Wrap(
                    spacing: gap,
                    runSpacing: gap,
                    children: [
                      for (final e in events)
                        SizedBox(width: cardWidth, child: EventCard(event: e)),
                    ],
                  );
                },
              ),
          ],
        );
      },
    );
  }

  // Hardcoded illustrative card shown next to the "be first" CTA in the empty
  // state. Clearly labelled EXAMPLE so it isn't mistaken for a real event.
  static const _exampleEvent = Event(
    emoji: '☕',
    title: 'Founders coffee',
    day: 'FRI · 19 JUN',
    organizer: 'You',
  );
}

class _EmptyHappeningState extends StatelessWidget {
  const _EmptyHappeningState({required this.example});

  final Event example;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isCompact = constraints.maxWidth < 640;
        final cta = Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: AppColors.cardBg,
            border: Border.all(color: AppColors.cardBorder),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Be the first to schedule something',
                style: serif(fontSize: 22, weight: FontWeight.w500),
              ),
              const SizedBox(height: 10),
              const Text(
                'Sign in, message the bot, say "drinks tonight at 8" — it pings '
                'every member who fits. Breakfast, walk, demo, dinner — '
                'anything works.',
                style: TextStyle(
                  color: AppColors.inkMuted,
                  fontSize: 14,
                  height: 1.5,
                ),
              ),
            ],
          ),
        );

        final exampleCard = Stack(
          children: [
            EventCard(event: example, gated: false),
            Positioned(
              top: 10,
              right: 10,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: AppColors.surfaceTint,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: AppColors.surfaceTintBorder),
                ),
                child: const Text(
                  'EXAMPLE',
                  style: TextStyle(
                    color: AppColors.inkMuted,
                    fontSize: 9,
                    letterSpacing: 1.4,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
          ],
        );

        if (isCompact) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              cta,
              const SizedBox(height: 16),
              exampleCard,
            ],
          );
        }
        return Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(child: cta),
            const SizedBox(width: 24),
            SizedBox(width: 240, child: exampleCard),
          ],
        );
      },
    );
  }
}
