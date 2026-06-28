import 'package:flutter/material.dart';

import '../config/channel_links.dart';
import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../utils/copy_email.dart';
import '../utils/open_link.dart';
import '../widgets/bot_demo_card.dart';
import '../widgets/brand_logos.dart';
import '../widgets/primary_button.dart';
import '../widgets/status_pill.dart';

/// White-label product landing — the page we pitch to event organizers who'd
/// run the concierge for their own event. Deliberately self-contained (it does
/// NOT use [AppScaffold]) so it carries none of the VivaTech-specific chrome —
/// no founder visit cards, no "Viva Tribe · VivaTech 2026" top bar, no branded
/// footer. The signed-in community screens keep that chrome; this one is a
/// generic product showcase under a neutral brand.
class LandingScreen extends StatelessWidget {
  const LandingScreen({super.key});

  /// The product name shown across the pitch. White-label by design — an
  /// organizer's attendees would only ever see the organizer's own brand; this
  /// is the name we sell under.
  static const String product = 'Tribu';

  /// Sales contact for demo requests.
  static const String contactEmail = 'franek@online-tribes.com';

  /// Smart link to the live community app (routes to the App Store / Play Store
  /// / web). The persistent "tribes" platform shown in the Beyond-the-event
  /// section is this app, white-labelled per organizer.
  static const String appUrl = 'https://onlinetribes.qrplanet.com/j2dfu1';

  /// Calendly booking page for the "Book a demo call" / founding-partner call.
  static const String calendlyUrl =
      'https://calendly.com/franek-1/founding-ot';

  /// One-tap entry into the LIVE concierge demo. Opens the real Telegram bot
  /// with `?start=demo`, which drops the prospect into a sandbox: sample
  /// attendees they can find + intro, and meetups they can spin up — so they
  /// feel the product before booking a call. (Telegram-first; one tap, no
  /// install for anyone who already has it.)
  static const String tryDemoUrl =
      'https://t.me/${ChannelLinks.telegramBotUsername}?start=demo';

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    return Scaffold(
      backgroundColor: AppColors.background,
      body: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(-0.6, -0.7),
            radius: 1.4,
            colors: [AppColors.backgroundGlow, AppColors.background],
            stops: [0.0, 0.55],
          ),
        ),
        child: SafeArea(
          child: SingleChildScrollView(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 1240),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const _PitchTopBar(),
                    Padding(
                      padding:
                          EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const SizedBox(height: 8),
                          const _EyebrowPill(),
                          const SizedBox(height: 32),
                          _Hero(isCompact: isCompact),
                          const SizedBox(height: 44),
                          const _EventTypesStrip(),
                          const SizedBox(height: 64),
                          const _DemosHeader(),
                          const SizedBox(height: 20),
                          const _BotDemos(),
                          const SizedBox(height: 72),
                          const _Surfaces(),
                          const SizedBox(height: 72),
                          const _AfterEvent(),
                          const SizedBox(height: 72),
                          const _HowItWorks(),
                          const SizedBox(height: 72),
                          const _WhyOrganizers(),
                          const SizedBox(height: 72),
                          const _Pricing(),
                          const SizedBox(height: 72),
                          const _CtaBand(),
                          const SizedBox(height: 64),
                        ],
                      ),
                    ),
                    const _PitchFooter(),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Opens the Calendly booking page in a new tab so a "Book a demo call" tap
/// lands on a real scheduler. (The footer email link still opens a mail
/// composer.)
void _bookDemo(BuildContext context) =>
    openLink(Uri.parse(LandingScreen.calendlyUrl));

/// Sends the prospect to the channel chooser (`/try`), where they pick Telegram
/// (one tap) or WhatsApp (sandbox) to enter the live demo.
void _tryDemo(BuildContext context) =>
    Navigator.of(context).pushNamed('/try');

/// The primary "Try the live demo" button plus a quiet "Book a demo call"
/// link beneath it — the two ways into the funnel. [alignEnd] right-aligns the
/// pair (desktop hero); otherwise it hugs the start.
class _CtaPair extends StatelessWidget {
  const _CtaPair({this.alignEnd = false});

  final bool alignEnd;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment:
          alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        PrimaryButton(
          label: 'Try the live demo',
          onPressed: () => _tryDemo(context),
        ),
        const SizedBox(height: 10),
        TextButton(
          onPressed: () => _bookDemo(context),
          style: TextButton.styleFrom(
            foregroundColor: AppColors.inkMuted,
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            textStyle:
                const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w500),
          ),
          child: const Text('or book a demo call →'),
        ),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Top bar — neutral product brand + demo CTA
// ─────────────────────────────────────────────────────────────────────────

class _PitchTopBar extends StatelessWidget {
  const _PitchTopBar();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    final brand = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const _BrandMark(),
        const SizedBox(width: 11),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              LandingScreen.product,
              style: const TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 16,
                color: AppColors.ink,
                letterSpacing: -0.2,
              ),
            ),
            const Text(
              'AI concierge for any event',
              style: TextStyle(fontSize: 11, color: AppColors.inkMuted),
            ),
          ],
        ),
      ],
    );

    final invite = _InviteLink();
    final demo =
        _DemoButton(label: 'Try the demo', onTap: () => _tryDemo(context));

    if (isCompact) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
        child: Row(
          children: [Flexible(child: brand), const Spacer(), demo],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 24),
      child: Row(
        children: [
          brand,
          const Spacer(),
          invite,
          const SizedBox(width: 22),
          demo,
        ],
      ),
    );
  }
}

/// Neutral, code-drawn product mark — a rounded gradient tile with a hub glyph
/// (the "connecting people" motif). Avoids depending on the Online Tribes logo
/// asset so the brand here reads as generic / rebrandable.
class _BrandMark extends StatelessWidget {
  const _BrandMark({this.size = 34});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.28),
        gradient: const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [AppColors.accent, Color(0xFF7C5CE0)],
        ),
      ),
      alignment: Alignment.center,
      child: Icon(Icons.hub, size: size * 0.5, color: AppColors.accentInk),
    );
  }
}

/// Quiet route into the live community for people who already hold an invite.
class _InviteLink extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: () => Navigator.of(context).pushNamed('/in'),
      style: TextButton.styleFrom(
        foregroundColor: AppColors.inkMuted,
        textStyle: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
      ),
      child: const Text('Have an invite?'),
    );
  }
}

class _DemoButton extends StatelessWidget {
  const _DemoButton({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.accent,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
          child: Text(
            label,
            style: const TextStyle(
              color: AppColors.accentInk,
              fontWeight: FontWeight.w600,
              fontSize: 14,
            ),
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Hero
// ─────────────────────────────────────────────────────────────────────────

class _EyebrowPill extends StatelessWidget {
  const _EyebrowPill();

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
              'WHITE-LABEL  ·  LIVES IN WHATSAPP & TELEGRAM',
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
  const _Hero({required this.isCompact});

  final bool isCompact;

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final titleSize = (width * 0.072).clamp(40.0, 86.0);

    final title = RichText(
      text: TextSpan(
        style: serif(fontSize: titleSize, weight: FontWeight.w500, height: 1.04),
        children: [
          const TextSpan(text: 'Turn your guest list\ninto a '),
          TextSpan(
            text: 'thriving community',
            style: serif(
              fontSize: titleSize,
              weight: FontWeight.w400,
              style: FontStyle.italic,
              color: AppColors.accent,
              height: 1.04,
            ),
          ),
          const TextSpan(text: '.'),
        ],
      ),
    );

    final lede = Text(
      'No event app to download — because there isn’t one. The AI concierge lives '
      'right inside WhatsApp & Telegram, the apps your guests already open every '
      'day. It helps them find the like-minded people they came for, spins up '
      'spontaneous meetups, and keeps everyone connecting long after it ends — all '
      'under your brand.',
      style: serif(
        fontSize: isCompact ? 16 : 20,
        weight: FontWeight.w400,
        style: FontStyle.italic,
        color: AppColors.inkMuted,
        height: 1.45,
        letterSpacing: -0.2,
      ),
    );

    const seatStatus =
        StatusPill(label: 'No app to download · WhatsApp & Telegram · your branding');

    if (isCompact) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          title,
          const SizedBox(height: 20),
          lede,
          const SizedBox(height: 28),
          const _CtaPair(),
          const SizedBox(height: 14),
          seatStatus,
        ],
      );
    }

    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          flex: 3,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              title,
              const SizedBox(height: 26),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: lede,
              ),
            ],
          ),
        ),
        const SizedBox(width: 32),
        const Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            _CtaPair(alignEnd: true),
            SizedBox(height: 12),
            seatStatus,
          ],
        ),
      ],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Bot demos — the product in action (genericized, no VivaTech tells)
// ─────────────────────────────────────────────────────────────────────────

class _DemosHeader extends StatelessWidget {
  const _DemosHeader();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;
    const left = Text(
      "WHAT YOUR ATTENDEES CAN DO  ·  ONE MESSAGE AWAY",
      style: TextStyle(
        fontSize: 11,
        letterSpacing: 1.4,
        color: AppColors.inkMuted,
        fontWeight: FontWeight.w600,
      ),
    );
    const right = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        WhatsAppLogo(size: 18),
        SizedBox(width: 6),
        TelegramLogo(size: 18),
        SizedBox(width: 10),
        Text(
          'WORKS IN WHATSAPP & TELEGRAM',
          style: TextStyle(
            fontSize: 11,
            letterSpacing: 1.4,
            color: AppColors.inkMuted,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
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

class _BotDemos extends StatelessWidget {
  const _BotDemos();

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    const bot = LandingScreen.product;
    final demos = <Widget>[
      const BotDemoCard(
        botName: bot,
        kicker: '01 · FIND PEOPLE',
        title: 'Find people',
        turns: [
          DemoTurn(text: '/find me', fromUser: true, time: '10:14'),
          DemoTurn(text: 'a climate VC', fromUser: true, time: '10:14'),
          DemoTurn(
            text:
                'Marcus Højlund — Copenhagen, boutique European fund, leads early-stage climate cheques. On-site until Fri. Free 19h tonight. Want me to ping?',
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
            "/find me — Tell $bot what you're after. It surfaces the human and asks before pinging.",
      ),
      const BotDemoCard(
        botName: bot,
        kicker: '02 · FIND A BUDDY',
        title: 'Find a buddy',
        turns: [
          DemoTurn(text: '/find buddy', fromUser: true, time: '10:14'),
          DemoTurn(
            text: 'For which session? (e.g. the AI keynote, 14h)',
            fromUser: false,
            time: '10:14',
          ),
          DemoTurn(text: 'the AI keynote 14h', fromUser: true, time: '10:15'),
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
        botName: bot,
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
            text: 'breakfast near the venue, tomorrow 8h',
            fromUser: true,
            time: '07:59',
          ),
          DemoTurn(
            text:
                'Got it:\n🥗 Breakfast meetup\n📅 Tomorrow · 08:00\n📍 Café by the main entrance',
            fromUser: false,
            time: '07:59',
          ),
          DemoTurn(text: 'yes', fromUser: true, time: '08:00'),
          DemoTurn(text: "Posting to the tribe. I'll DM", fromUser: false),
        ],
        caption:
            '/create event — Drop the what, where, when. $bot posts it, collects RSVPs, and opens a group that lives on.',
      ),
      const BotDemoCard(
        botName: bot,
        kicker: '04 · JOIN ANYTHING',
        title: 'Join anything',
        turns: [
          DemoTurn(
            text:
                '📣 New from Léa:\n🥗 Breakfast meetup\n📅 Tomorrow · 08:00\n📍 Café by the main entrance\n\nReply `in` to join.',
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
            'in — One word to RSVP. $bot spins up the group chat the moment it’s worth meeting.',
      ),
    ];

    if (width < 760) {
      // Carousel sizes to the tallest card's natural height so the caption
      // beneath each demo is always visible.
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < demos.length; i++) ...[
              if (i > 0) const SizedBox(width: 16),
              SizedBox(width: 280, child: demos[i]),
            ],
          ],
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

// ─────────────────────────────────────────────────────────────────────────
//  Meet them on every surface — chat / web / your own branded app
// ─────────────────────────────────────────────────────────────────────────

class _Surfaces extends StatelessWidget {
  const _Surfaces();

  // `tag` is a small accent pill (empty = none); the branded app is flagged
  // as the white-label upsell.
  static const _surfaces = [
    (
      icon: Icons.chat_bubble_outline,
      logo: WhatsAppLogo(),
      title: 'WhatsApp',
      body: 'Already on every guest’s phone. They just tap to chat — nothing to '
          'install.',
      tag: '',
    ),
    (
      icon: Icons.send_outlined,
      logo: TelegramLogo(),
      title: 'Telegram',
      body: 'Bot-native and instant. One tap from a link, zero setup.',
      tag: '',
    ),
    (
      icon: Icons.public,
      logo: null,
      title: 'Web app',
      body: 'No messenger? Open a link in any browser. Still nothing to download.',
      tag: '',
    ),
    (
      icon: Icons.phone_iphone,
      logo: null,
      title: 'Your own branded app',
      body: 'Optional. Want a native iOS & Android app with your name on it? '
          'Add one anytime.',
      tag: 'OPTIONAL',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    final columns = isCompact ? 1 : (width < 1100 ? 2 : 4);
    final cards = [
      for (final s in _surfaces)
        _SurfaceCard(
          icon: s.icon,
          logo: s.logo,
          title: s.title,
          body: s.body,
          tag: s.tag,
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('NO APP TO DOWNLOAD'),
        const SizedBox(height: 8),
        Text(
          'It lives where your guests\nalready are.',
          style: serif(fontSize: isCompact ? 28 : 40, weight: FontWeight.w500),
        ),
        const SizedBox(height: 10),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620),
          child: Text(
            'No one installs yet another event app — there isn’t one. Your guests '
            'just open a chat they already have. That’s why they actually use it.',
            style: TextStyle(
              fontSize: isCompact ? 14 : 15.5,
              height: 1.5,
              color: AppColors.inkMuted,
            ),
          ),
        ),
        const SizedBox(height: 28),
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 16.0;
            final cardWidth =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final c in cards) SizedBox(width: cardWidth, child: c),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _SurfaceCard extends StatelessWidget {
  const _SurfaceCard({
    required this.icon,
    required this.title,
    required this.body,
    this.logo,
    this.tag = '',
  });

  final IconData icon;
  final String title;
  final String body;

  /// Brand logo to show in place of the generic tinted icon square (e.g. the
  /// WhatsApp / Telegram marks). Null falls back to [icon] on an accent tile.
  final Widget? logo;

  /// Optional accent pill in the top-right (empty = none).
  final String tag;

  @override
  Widget build(BuildContext context) {
    final highlighted = tag.isNotEmpty;
    final leading = logo ??
        Container(
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: AppColors.accentSoft,
            borderRadius: BorderRadius.circular(12),
          ),
          alignment: Alignment.center,
          child: Icon(icon, size: 20, color: AppColors.accent),
        );
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: highlighted ? AppColors.accent : AppColors.cardBorder,
        ),
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              leading,
              if (highlighted) ...[
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.accentSoft,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    tag,
                    style: const TextStyle(
                      fontSize: 9,
                      letterSpacing: 1.0,
                      fontWeight: FontWeight.w700,
                      color: AppColors.accent,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 14),
          Text(
            title,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: AppColors.ink,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            body,
            style: const TextStyle(
              fontSize: 13,
              height: 1.45,
              color: AppColors.inkMuted,
            ),
          ),
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  After the event — the persistent community platform (small tribes)
// ─────────────────────────────────────────────────────────────────────────

/// Pitches the white-label community space that lives on after the event: a
/// private little social network where guests keep in touch in small tribes —
/// "their own small Facebook" — so the relationships made on the floor survive.
class _AfterEvent extends StatelessWidget {
  const _AfterEvent();

  static const _features = [
    (
      icon: Icons.group_add_outlined,
      title: 'Every meetup becomes a tribe',
      body:
          'Someone spins up a sub-event — say, a morning breakfast — and the bot '
              'opens a tribe for it. Everyone who joins the meetup joins the tribe.',
    ),
    (
      icon: Icons.groups_outlined,
      title: 'Small tribes, not a megafeed',
      body:
          'Members gather in small, focused groups — their own little Facebook, '
              'minus the noise. Profiles, posts and group chats included.',
    ),
    (
      icon: Icons.all_inclusive,
      title: 'Relationships that survive',
      body:
          'The group doesn’t close when the event does. Guests keep meeting all '
              'year — a 3-day badge that becomes a lasting community.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    final columns = isCompact ? 1 : 3;
    final cards = [
      for (final f in _features)
        _BenefitCard(icon: f.icon, title: f.title, body: f.body),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('BEYOND THE EVENT'),
        const SizedBox(height: 8),
        Text(
          'When the event ends,\nthe tribe doesn’t.',
          style: serif(fontSize: isCompact ? 28 : 40, weight: FontWeight.w500),
        ),
        const SizedBox(height: 10),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Text(
            'At a big event, anyone can spin up a smaller meetup — a morning '
            'breakfast, a hallway coffee, a post-talk drink. The moment they do, '
            'the bot turns that sub-event into its own tribe, and everyone who '
            'joins it lands there together. The meetup ends; the tribe doesn’t — '
            'it lives on in a private, white-label community of your own, so the '
            'people who actually met stay in touch long after everyone flies home.',
            style: TextStyle(
              fontSize: isCompact ? 14 : 15.5,
              height: 1.5,
              color: AppColors.inkMuted,
            ),
          ),
        ),
        const SizedBox(height: 28),
        const _AppShowcase(),
        const SizedBox(height: 28),
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 16.0;
            final cardWidth =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final c in cards) SizedBox(width: cardWidth, child: c),
              ],
            );
          },
        ),
      ],
    );
  }
}

/// Real screenshots of the live community app (white-labelled per organizer),
/// with a link straight into it. Proof the platform exists today — not a mock.
class _AppShowcase extends StatelessWidget {
  const _AppShowcase();

  static const _shots = [
    (
      asset: 'assets/online_tribes/tribe.jpg',
      caption: 'Small tribes — real conversations, not feeds.',
    ),
    (
      asset: 'assets/online_tribes/translate.jpg',
      caption: 'Live translation — one tribe, every language.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;
    final shotWidth = isCompact ? 210.0 : 248.0;

    final phones = [
      for (final s in _shots)
        SizedBox(width: shotWidth, child: _PhoneShot(asset: s.asset, caption: s.caption)),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 20,
          runSpacing: 24,
          children: phones,
        ),
        const SizedBox(height: 22),
        const _LiveAppLink(),
      ],
    );
  }
}

class _PhoneShot extends StatelessWidget {
  const _PhoneShot({required this.asset, required this.caption});

  final String asset;
  final String caption;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: AppColors.cardBorder),
          ),
          child: Image.asset(asset, fit: BoxFit.cover),
        ),
        const SizedBox(height: 10),
        Text(
          caption,
          style: const TextStyle(
            fontSize: 12.5,
            height: 1.4,
            color: AppColors.inkMuted,
          ),
        ),
      ],
    );
  }
}

/// Accent text link that opens the live community app.
class _LiveAppLink extends StatelessWidget {
  const _LiveAppLink();

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.accentSoft,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: () => openLink(Uri.parse(LandingScreen.appUrl)),
        child: const Padding(
          padding: EdgeInsets.symmetric(horizontal: 18, vertical: 11),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.phone_iphone, size: 16, color: AppColors.accent),
              SizedBox(width: 9),
              Text(
                'See the live app',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                  color: AppColors.accent,
                ),
              ),
              SizedBox(width: 6),
              Icon(Icons.arrow_outward, size: 15, color: AppColors.accent),
            ],
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  How it works (for organizers)
// ─────────────────────────────────────────────────────────────────────────

class _HowItWorks extends StatelessWidget {
  const _HowItWorks();

  static const _steps = [
    (
      no: '01',
      title: 'Bring your crowd',
      body:
          'Connect your ticketing or drop in a guest list. Everyone gets a '
              'private link that lands them straight in the concierge.',
    ),
    (
      no: '02',
      title: 'Your brand, not ours',
      body:
          'We skin the concierge with your event’s name, colours and logo. '
              'Attendees only ever see you — never us.',
    ),
    (
      no: '03',
      title: 'It does the connecting',
      body:
          'Attendees just message the bot. It matches the right people, sets up '
              'meetups, and runs the room around the clock.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;
    final cards = [
      for (final s in _steps)
        _StepCard(no: s.no, title: s.title, body: s.body, expand: !isCompact),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('HOW IT WORKS FOR ORGANIZERS'),
        const SizedBox(height: 8),
        Text(
          'Branded and live in days.',
          style: serif(fontSize: isCompact ? 28 : 40, weight: FontWeight.w500),
        ),
        const SizedBox(height: 28),
        if (isCompact)
          Column(
            children: [
              for (var i = 0; i < cards.length; i++) ...[
                if (i > 0) const SizedBox(height: 14),
                cards[i],
              ],
            ],
          )
        else
          // IntrinsicHeight gives the Row a bounded cross-axis so the cards can
          // stretch to equal heights — without it, CrossAxisAlignment.stretch
          // inherits the scroll view's unbounded height and fails to lay out.
          IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < cards.length; i++) ...[
                  if (i > 0) const SizedBox(width: 16),
                  Expanded(child: cards[i]),
                ],
              ],
            ),
          ),
      ],
    );
  }
}

class _StepCard extends StatelessWidget {
  const _StepCard({
    required this.no,
    required this.title,
    required this.body,
    this.expand = false,
  });

  final String no;
  final String title;
  final String body;

  /// When the cards are laid out in an equal-height row (desktop), the body
  /// flexes to fill the card so sub-pixel text-layout rounding can't overflow
  /// the bottom by ~1px. In the compact stack the card height is unbounded, so
  /// this must stay false (an Expanded would throw with no bounded main axis).
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final bodyText = Text(
      body,
      style: const TextStyle(
        fontSize: 13.5,
        height: 1.5,
        color: AppColors.inkMuted,
      ),
    );
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.cardBorder),
      ),
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            no,
            style: serif(
              fontSize: 30,
              weight: FontWeight.w400,
              style: FontStyle.italic,
              color: AppColors.accent,
            ),
          ),
          const SizedBox(height: 14),
          Text(
            title,
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: AppColors.ink,
            ),
          ),
          const SizedBox(height: 8),
          if (expand) Expanded(child: bodyText) else bodyText,
        ],
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Why organizers run it
// ─────────────────────────────────────────────────────────────────────────

class _WhyOrganizers extends StatelessWidget {
  const _WhyOrganizers();

  static const _benefits = [
    (
      icon: Icons.diversity_3,
      title: 'Everyone finds their people',
      body:
          'The #1 reason people show up is the people. The concierge connects '
              'the like-minded ones who’d otherwise never cross paths.',
    ),
    (
      icon: Icons.handshake_outlined,
      title: 'No more cold approaches',
      body:
          'The concierge warms up every introduction, so no one walks up to a '
              'stranger cold. Connecting feels natural — the awkward part is gone.',
    ),
    (
      icon: Icons.palette_outlined,
      title: 'Your brand, end to end',
      body:
          'White-label by default — your name on the welcome, your colours on '
              'the page, your event in every message.',
    ),
    (
      icon: Icons.touch_app_outlined,
      title: 'Adoption that actually happens',
      body:
          'Event apps die because no one downloads them. This one is already on '
              'every phone — so guests actually open it, and keep using it.',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    final columns = isCompact ? 1 : 2;
    final cards = [
      for (final b in _benefits)
        _BenefitCard(icon: b.icon, title: b.title, body: b.body),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('WHY ORGANIZERS RUN IT'),
        const SizedBox(height: 8),
        Text(
          'The networking your event\nalready promises.',
          style: serif(fontSize: isCompact ? 28 : 40, weight: FontWeight.w500),
        ),
        const SizedBox(height: 28),
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 16.0;
            final cardWidth =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final c in cards) SizedBox(width: cardWidth, child: c),
              ],
            );
          },
        ),
      ],
    );
  }
}

class _BenefitCard extends StatelessWidget {
  const _BenefitCard(
      {required this.icon, required this.title, required this.body});

  final IconData icon;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.cardBorder),
      ),
      padding: const EdgeInsets.all(24),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: AppColors.accentSoft,
              borderRadius: BorderRadius.circular(12),
            ),
            alignment: Alignment.center,
            child: Icon(icon, size: 20, color: AppColors.accent),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: AppColors.ink,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  body,
                  style: const TextStyle(
                    fontSize: 13.5,
                    height: 1.5,
                    color: AppColors.inkMuted,
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

// ─────────────────────────────────────────────────────────────────────────
//  Pricing — per-event tiers, branded app + annual license as the anchors
// ─────────────────────────────────────────────────────────────────────────

class _Pricing extends StatelessWidget {
  const _Pricing();

  static const _tiers = [
    (
      name: 'Starter',
      size: 'Up to 250 guests',
      price: 'from €1,000',
      period: '/ event',
      features: [
        'WhatsApp, Telegram & web app',
        'Your event’s branding',
        'Smart intros, buddies & meetups',
        'Community space — tribes that live on',
      ],
      tag: '',
    ),
    (
      name: 'Growth',
      size: 'Up to 1,500 guests',
      price: 'from €3,500',
      period: '/ event',
      features: [
        'Everything in Starter',
        'Engagement analytics',
        'Priority support',
      ],
      tag: 'MOST POPULAR',
    ),
    (
      name: 'Pro',
      size: 'Up to 5,000 guests',
      price: 'from €9,000',
      period: '/ event',
      features: [
        'Everything in Growth',
        'Dedicated setup',
        'Custom matching rules',
      ],
      tag: '',
    ),
    (
      name: 'Enterprise',
      size: '5,000+ · series · agencies',
      price: 'Custom',
      period: '',
      features: [
        'White-label native app',
        'Annual license',
        'Dedicated infra & SLA',
        'Sponsor / rev-share options',
      ],
      tag: '',
    ),
  ];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 760;
    final columns = isCompact ? 1 : (width < 1100 ? 2 : 4);
    final cards = [
      for (final t in _tiers)
        _PriceCard(
          name: t.name,
          size: t.size,
          price: t.price,
          period: t.period,
          features: t.features,
          tag: t.tag,
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('PRICING'),
        const SizedBox(height: 8),
        Text(
          'Pay per event. Scale as you grow.',
          style: serif(fontSize: isCompact ? 28 : 40, weight: FontWeight.w500),
        ),
        const SizedBox(height: 10),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Text(
            'Transparent pricing that tracks your room — not a per-seat meter. '
            'Every tier is fully branded; add a native white-label app whenever '
            'you want one.',
            style: TextStyle(
              fontSize: isCompact ? 14 : 15.5,
              height: 1.5,
              color: AppColors.inkMuted,
            ),
          ),
        ),
        const SizedBox(height: 28),
        LayoutBuilder(
          builder: (context, constraints) {
            const gap = 16.0;
            final cardWidth =
                (constraints.maxWidth - gap * (columns - 1)) / columns;
            return Wrap(
              spacing: gap,
              runSpacing: gap,
              children: [
                for (final c in cards) SizedBox(width: cardWidth, child: c),
              ],
            );
          },
        ),
        const SizedBox(height: 20),
        Text(
          'Prefer to pay for outcomes? From €2.50 per guest who actually '
          'connects (pilots from €1). Series, communities & agencies: annual '
          'licenses from €15k/yr.',
          style: const TextStyle(
            fontSize: 13,
            height: 1.5,
            color: AppColors.inkSubtle,
          ),
        ),
      ],
    );
  }
}

class _PriceCard extends StatelessWidget {
  const _PriceCard({
    required this.name,
    required this.size,
    required this.price,
    required this.period,
    required this.features,
    this.tag = '',
  });

  final String name;
  final String size;
  final String price;
  final String period;
  final List<String> features;

  /// Optional accent pill (empty = none) — flags the recommended tier.
  final String tag;

  @override
  Widget build(BuildContext context) {
    final highlighted = tag.isNotEmpty;
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(
          color: highlighted ? AppColors.accent : AppColors.cardBorder,
        ),
      ),
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                name,
                style: const TextStyle(
                  fontSize: 15,
                  fontWeight: FontWeight.w700,
                  color: AppColors.ink,
                ),
              ),
              if (highlighted) ...[
                const Spacer(),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(
                    color: AppColors.accentSoft,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    tag,
                    style: const TextStyle(
                      fontSize: 9,
                      letterSpacing: 1.0,
                      fontWeight: FontWeight.w700,
                      color: AppColors.accent,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          Text(
            size,
            style: const TextStyle(fontSize: 12, color: AppColors.inkMuted),
          ),
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Flexible(
                child: Text(
                  price,
                  style: serif(fontSize: 27, weight: FontWeight.w500),
                ),
              ),
              if (period.isNotEmpty) ...[
                const SizedBox(width: 6),
                Text(
                  period,
                  style: const TextStyle(fontSize: 13, color: AppColors.inkMuted),
                ),
              ],
            ],
          ),
          const SizedBox(height: 18),
          Container(height: 1, color: AppColors.divider),
          const SizedBox(height: 16),
          for (final f in features)
            Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.check, size: 16, color: AppColors.accent),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      f,
                      style: const TextStyle(
                        fontSize: 13,
                        height: 1.4,
                        color: AppColors.inkMuted,
                      ),
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

// ─────────────────────────────────────────────────────────────────────────
//  Closing CTA band
// ─────────────────────────────────────────────────────────────────────────

class _CtaBand extends StatelessWidget {
  const _CtaBand();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 760;
    final heading = Text(
      'Run it at your next event.',
      style: serif(fontSize: isCompact ? 30 : 46, weight: FontWeight.w500),
    );
    final sub = Text(
      'Tell us about your event — we’ll show you the concierge live and have it '
      'branded for you in days.',
      style: TextStyle(
        fontSize: isCompact ? 14 : 15.5,
        height: 1.5,
        color: AppColors.inkMuted,
      ),
    );
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(28),
        gradient: const RadialGradient(
          center: Alignment(0.7, -0.9),
          radius: 1.6,
          colors: [AppColors.backgroundGlow, AppColors.cardBg],
          stops: [0.0, 0.7],
        ),
        border: Border.all(color: AppColors.cardBorder),
      ),
      padding: EdgeInsets.symmetric(
        horizontal: isCompact ? 28 : 56,
        vertical: isCompact ? 40 : 56,
      ),
      child: isCompact
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                heading,
                const SizedBox(height: 14),
                sub,
                const SizedBox(height: 28),
                const _CtaPair(),
              ],
            )
          : Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      heading,
                      const SizedBox(height: 14),
                      ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 520),
                        child: sub,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 40),
                const _CtaPair(alignEnd: true),
              ],
            ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: const TextStyle(
        fontSize: 11,
        letterSpacing: 1.4,
        color: AppColors.accent,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  "Built for tech events" — names the vertical we sell into
// ─────────────────────────────────────────────────────────────────────────

class _EventTypesStrip extends StatelessWidget {
  const _EventTypesStrip();

  static const _types = [
    'Conferences',
    'Festivals',
    'Meetups',
    'Retreats',
    'Trade shows',
    'Workshops',
    'Communities',
    'Offsites',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _SectionLabel('FOR EVENTS OF EVERY KIND'),
        const SizedBox(height: 14),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [for (final t in _types) _TypeChip(label: t)],
        ),
      ],
    );
  }
}

class _TypeChip extends StatelessWidget {
  const _TypeChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: BoxDecoration(
        color: AppColors.surfaceTint,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppColors.surfaceTintBorder),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w500,
          color: AppColors.ink,
        ),
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Footer — neutral product credit (no "Viva Tribe gathering")
// ─────────────────────────────────────────────────────────────────────────

class _PitchFooter extends StatelessWidget {
  const _PitchFooter();

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    final left = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const _BrandMark(size: 20),
        const SizedBox(width: 10),
        Flexible(
          child: Text(
            '${LandingScreen.product} · an Online Tribes product',
            style: const TextStyle(fontSize: 12, color: AppColors.inkMuted),
          ),
        ),
      ],
    );
    final right = MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => emailAction(context, LandingScreen.contactEmail),
        child: const Text(
          LandingScreen.contactEmail,
          style: TextStyle(
            fontSize: 12,
            color: AppColors.inkMuted,
            decoration: TextDecoration.underline,
            decorationColor: AppColors.inkSubtle,
          ),
        ),
      ),
    );

    return Padding(
      padding: EdgeInsets.symmetric(
        horizontal: isCompact ? 20 : 40,
        vertical: 28,
      ),
      child: isCompact
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [left, const SizedBox(height: 12), right],
            )
          : Row(children: [left, const Spacer(), right]),
    );
  }
}
