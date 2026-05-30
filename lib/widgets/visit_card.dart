import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../utils/open_link.dart';

/// Persistent "visit cards" rendered under the top bar on every page.
/// Two hosts stacked: Franek + Marianna. Each card has its own initials,
/// tagline, and link chips. Chips open in a new tab on web / external app on
/// mobile via `url_launcher`.
class VisitCard extends StatelessWidget {
  const VisitCard({super.key});

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    return Padding(
      padding: EdgeInsets.fromLTRB(isCompact ? 20 : 40, 12, isCompact ? 20 : 40, 4),
      child: Column(
        // Stretch so both host cards fill the available width and match each
        // other. Without this, the compact layout (a plain Column with no
        // Expanded) lets each card shrink to its own content — Franek's 4 chips
        // make his card wider than Marianna's 2.
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: const [
          _HostCard(
            initials: 'FJ',
            imagePath: 'assets/founders/Franek.jpeg',
            name: 'Franek Jablonski',
            tagline: 'Hosting Viva Tribe at VivaTech 2026',
            links: [
              _Link(icon: Icons.mail_outline, label: 'franek@online-tribes.com', url: 'mailto:franek@online-tribes.com'),
              _Link(icon: Icons.link, label: 'LinkedIn', url: 'https://www.linkedin.com/in/franek-jablonski/'),
              _Link(icon: Icons.code, label: 'GitHub', url: 'https://github.com/budda24'),
              _Link(icon: Icons.phone_iphone, label: 'OnlineTribes app', url: 'https://onlinetribes.qrplanet.com/j2dfu1'),
            ],
          ),
          SizedBox(height: 10),
          _HostCard(
            initials: 'MJ',
            imagePath: 'assets/founders/Marianna.jpeg',
            name: 'Marianna Jablonska',
            tagline: 'Co-founder · Online Tribes',
            links: [
              _Link(icon: Icons.mail_outline, label: 'marianna@online-tribes.com', url: 'mailto:marianna@online-tribes.com'),
              _Link(icon: Icons.link, label: 'LinkedIn', url: 'https://www.linkedin.com/in/mariannajablonska/'),
            ],
          ),
        ],
      ),
    );
  }
}

class _Link {
  const _Link({required this.icon, required this.label, required this.url});
  final IconData icon;
  final String label;
  final String url;
}

class _HostCard extends StatelessWidget {
  const _HostCard({
    required this.initials,
    this.imagePath,
    required this.name,
    required this.tagline,
    required this.links,
  });

  final String initials;
  final String? imagePath;
  final String name;
  final String tagline;
  final List<_Link> links;

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    final identity = _Identity(initials: initials, imagePath: imagePath, name: name, tagline: tagline);
    final chips = _Chips(links: links);
    return Container(
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: AppColors.cardBorder),
      ),
      padding: EdgeInsets.symmetric(
        horizontal: isCompact ? 16 : 24,
        vertical: isCompact ? 16 : 18,
      ),
      child: isCompact
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [identity, const SizedBox(height: 14), chips],
            )
          : Row(children: [Expanded(child: identity), chips]),
    );
  }
}

class _Identity extends StatelessWidget {
  const _Identity({required this.initials, this.imagePath, required this.name, required this.tagline});

  final String initials;
  final String? imagePath;
  final String name;
  final String tagline;

  @override
  Widget build(BuildContext context) {
    // Use the photo when available; fall back to initials on a tinted disc.
    final Widget avatar = imagePath != null
        ? ClipOval(
            child: Image.asset(
              imagePath!,
              width: 44,
              height: 44,
              fit: BoxFit.cover,
              errorBuilder: (_, _, _) => _InitialsDisc(initials: initials),
            ),
          )
        : _InitialsDisc(initials: initials);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        avatar,
        const SizedBox(width: 12),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              name,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: AppColors.ink,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              tagline,
              style: const TextStyle(fontSize: 12, color: AppColors.inkMuted),
            ),
          ],
        ),
      ],
    );
  }
}

class _InitialsDisc extends StatelessWidget {
  const _InitialsDisc({required this.initials});

  final String initials;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 44,
      decoration: const BoxDecoration(
        color: AppColors.accentSoft,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        initials,
        style: const TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: AppColors.accent,
          letterSpacing: 0.5,
        ),
      ),
    );
  }
}

class _Chips extends StatelessWidget {
  const _Chips({required this.links});

  final List<_Link> links;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final l in links)
          _LinkChip(
            icon: l.icon,
            label: l.label,
            onTap: () => openLink(Uri.parse(l.url)),
          ),
      ],
    );
  }
}

class _LinkChip extends StatelessWidget {
  const _LinkChip({required this.icon, required this.label, required this.onTap});

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surfaceTint,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 14, color: AppColors.accent),
              const SizedBox(width: 8),
              Text(
                label,
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w500,
                  color: AppColors.ink,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
