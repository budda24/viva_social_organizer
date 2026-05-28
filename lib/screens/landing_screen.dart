import 'package:flutter/material.dart';

import '../data/sample_data.dart';
import '../models/speaker.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';
import '../widgets/bot_demo_card.dart';
import '../widgets/primary_button.dart';
import '../widgets/speaker_card.dart';
import '../widgets/status_pill.dart';

class LandingScreen extends StatelessWidget {
  const LandingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    return AppScaffold(
      topBarTrailing: const StatusPill(label: '74 / 100 tribers'),
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 8),
            const _InviteOnlyPill(),
            const SizedBox(height: 32),
            _Hero(isCompact: isCompact, onInvite: () => Navigator.of(context).pushNamed('/in')),
            const SizedBox(height: 56),
            const _BotDemos(),
            const SizedBox(height: 64),
            const _SpeakersHeader(),
            const SizedBox(height: 20),
            _SpeakerGrid(speakers: sampleSpeakers),
            const SizedBox(height: 56),
          ],
        ),
      ),
    );
  }
}

class _InviteOnlyPill extends StatelessWidget {
  const _InviteOnlyPill();

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: AppColors.surfaceTint,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: AppColors.surfaceTintBorder),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.auto_awesome, size: 13, color: AppColors.accent),
            SizedBox(width: 8),
            Text(
              'INVITE-ONLY  ·  VIVATECH 2026',
              style: TextStyle(
                fontSize: 11,
                letterSpacing: 1.3,
                color: AppColors.ink,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.isCompact, required this.onInvite});

  final bool isCompact;
  final VoidCallback onInvite;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final titleSize = (width * 0.085).clamp(52.0, 112.0);

    final title = RichText(
      text: TextSpan(
        style: serif(fontSize: titleSize, weight: FontWeight.w500),
        children: [
          const TextSpan(text: 'Viva '),
          TextSpan(
            text: 'Tribe',
            style: serif(
              fontSize: titleSize,
              weight: FontWeight.w400,
              style: FontStyle.italic,
              color: AppColors.accent,
            ),
          ),
          const TextSpan(text: '.'),
        ],
      ),
    );

    final lede = Text(
      'Your first five humans at the show — not your first five hundred followers.',
      style: serif(
        fontSize: isCompact ? 17 : 22,
        weight: FontWeight.w400,
        style: FontStyle.italic,
        color: AppColors.inkMuted,
        height: 1.4,
        letterSpacing: -0.2,
      ),
    );

    final cta = PrimaryButton(label: 'I have an invite', onPressed: onInvite);
    const seatStatus = StatusPill(label: '74 / 100 seated · 12 free tonight');

    if (isCompact) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          title,
          const SizedBox(height: 18),
          lede,
          const SizedBox(height: 28),
          cta,
          const SizedBox(height: 12),
          seatStatus,
        ],
      );
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              title,
              const SizedBox(height: 24),
              lede,
            ],
          ),
        ),
        const SizedBox(width: 32),
        Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            cta,
            const SizedBox(height: 12),
            seatStatus,
          ],
        ),
      ],
    );
  }
}

class _BotDemos extends StatelessWidget {
  const _BotDemos();

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final demos = <Widget>[
      const BotDemoCard(
        kicker: '01 · FIND PEOPLE',
        title: 'Find people',
        turns: [
          DemoTurn(text: '/find me', fromUser: true, time: '10:14'),
          DemoTurn(text: 'a climate VC', fromUser: true, time: '10:14'),
          DemoTurn(
            text:
                'Marcus Højlund — Copenhagen, boutique European fund, leads early-stage climate cheques. In Paris until Fri. Free 19h tonight. Want me to ping?',
            fromUser: false,
            time: '10:15',
          ),
          DemoTurn(text: 'yes please', fromUser: true, time: '10:15'),
          DemoTurn(
            text: 'Pinging Marcus ✅ No direct contact swap yet —',
            fromUser: false,
          ),
        ],
        caption:
            "/find me — Tell Tribu what you're after. It surfaces the human and asks before pinging.",
      ),
      const BotDemoCard(
        kicker: '02 · FIND A BUDDY',
        title: 'Find a buddy',
        turns: [
          DemoTurn(text: '/find buddy', fromUser: true, time: '10:14'),
          DemoTurn(
            text: 'For which session? (e.g. LeCun keynote, 14h)',
            fromUser: false,
            time: '10:14',
          ),
          DemoTurn(text: 'LeCun keynote 14h', fromUser: true, time: '10:15'),
          DemoTurn(
            text:
                'Yuki Tanaka (Tokyo, agentic CRM) is also going. Want me to set you up to meet at the entrance?',
            fromUser: false,
            time: '10:15',
          ),
          DemoTurn(text: 'yes', fromUser: true, time: '10:15'),
          DemoTurn(text: 'Done ✅ Group chat', fromUser: false),
        ],
        caption:
            '/find buddy — Pair up for a session, a panel, a walk to the after-party. Never go alone.',
      ),
      const BotDemoCard(
        kicker: '03 · CREATE EVENTS',
        title: 'Create events',
        turns: [
          DemoTurn(text: '/create event', fromUser: true, time: '07:58'),
          DemoTurn(
            text: 'Quick one — give me what, where, when.',
            fromUser: false,
            time: '07:58',
          ),
          DemoTurn(
            text: 'breakfast at Le Marais, tomorrow 8h',
            fromUser: true,
            time: '07:59',
          ),
          DemoTurn(
            text:
                'Got it:\n🥗 Breakfast at Le Marais\n📅 Wed 18 Jun · 08:00\n📍 Le Mary, 17 rue du Roi de Sicile',
            fromUser: false,
            time: '07:59',
          ),
          DemoTurn(text: 'yes', fromUser: true, time: '08:00'),
          DemoTurn(text: "Posting to the tribe. I'll DM", fromUser: false),
        ],
        caption:
            '/create event — Drop the what, where, when. Tribu posts and collects RSVPs in DMs.',
      ),
      const BotDemoCard(
        kicker: '04 · JOIN ANYTHING',
        title: 'Join anything',
        turns: [
          DemoTurn(
            text:
                '📣 New from Léa:\n🥗 Breakfast at Le Marais\n📅 Wed 18 Jun · 08:00\n📍 Le Mary, 17 rue du Roi de Sicile\n\nReply `in` to join.',
            fromUser: false,
            time: '08:02',
          ),
          DemoTurn(text: 'in', fromUser: true, time: '08:02'),
          DemoTurn(
            text:
                "You're in ✅\n4 going so far: Léa, Yuki, Marcus, you. I'll send the group chat at 19h tonight.",
            fromUser: false,
            time: '08:02',
          ),
        ],
        caption:
            'in — One word to RSVP. Tribu spins up the group chat the moment it’s worth meeting.',
      ),
    ];

    if (width < 760) {
      return SizedBox(
        height: 540,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: EdgeInsets.zero,
          itemCount: demos.length,
          separatorBuilder: (_, _) => const SizedBox(width: 16),
          itemBuilder: (_, i) => SizedBox(width: 280, child: demos[i]),
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const gap = 16.0;
        final cardWidth = (constraints.maxWidth - gap * 3) / 4;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final d in demos) SizedBox(width: cardWidth, child: d),
          ],
        );
      },
    );
  }
}

class _SpeakersHeader extends StatelessWidget {
  const _SpeakersHeader();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;
    const left = Text(
      "IN THE ROOM  ·  SPEAKERS YOU'LL CROSS PATHS WITH",
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 1.4,
        color: AppColors.inkMuted,
        fontWeight: FontWeight.w600,
      ),
    );
    const right = Text(
      '17 → 20 JUN  ·  PORTE DE VERSAILLES',
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 1.4,
        color: AppColors.inkMuted,
        fontWeight: FontWeight.w600,
      ),
    );

    if (isCompact) {
      return const Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [left, SizedBox(height: 6), right],
      );
    }
    return const Row(children: [left, Spacer(), right]);
  }
}

class _SpeakerGrid extends StatelessWidget {
  const _SpeakerGrid({required this.speakers});

  final List<Speaker> speakers;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;

    if (width < 760) {
      return SizedBox(
        height: 290,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: EdgeInsets.zero,
          itemCount: speakers.length,
          separatorBuilder: (_, _) => const SizedBox(width: 14),
          itemBuilder: (_, i) => SizedBox(
            width: 200,
            child: SpeakerCard(speaker: speakers[i]),
          ),
        ),
      );
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 1100 ? 5 : 3;
        const gap = 16.0;
        final cardWidth =
            (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final speaker in speakers)
              SizedBox(width: cardWidth, child: SpeakerCard(speaker: speaker)),
          ],
        );
      },
    );
  }
}
