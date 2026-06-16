// Pitches — two tabs, each rendering an HTML pitch deck inside an iframe.
// Editing the HTML files under web/decks/ is the whole update flow; no Dart
// changes needed when the deck content shifts.
//
// Layout: title + pill tab bar + active panel. Omnia also gets a YouTube embed
// (the Omnia presentation) above its deck; Online Tribes' video lands later.

import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:web/web.dart' as web;

import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';

const _onlineTribesDeckUrl = 'decks/online-tribes.html';
const _onlineTribesDeckViewType = 'deck-online-tribes';

const _omniaDeckUrl = 'decks/omnia.html';
const _omniaDeckViewType = 'deck-omnia';

// Omnia presentation hosted on YouTube — embedded rather than served as a
// local mp4 so Firebase Hosting doesn't ship a ~33 MB asset and the player
// gets adaptive streaming + fullscreen for free. youtube-nocookie avoids
// dropping tracking cookies until the visitor actually hits play.
const _omniaYouTubeId = '0oGbF0Jldj8';
const _omniaVideoViewType = 'omnia-youtube';

class PitchesScreen extends StatefulWidget {
  const PitchesScreen({super.key});

  @override
  State<PitchesScreen> createState() => _PitchesScreenState();
}

class _PitchesScreenState extends State<PitchesScreen> {
  int _selected = 0;

  // Omnia first so it's the default tab — the demo video is what opens.
  static const _tabs = ['Omnia', 'Online Tribes'];

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;

    return AppScaffold(
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: isCompact ? 20 : 40,
          vertical: isCompact ? 24 : 48,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Pitches',
              style: serif(
                fontSize: isCompact ? 38 : 56,
                weight: FontWeight.w500,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Founder pitches from the circle.',
              style: TextStyle(color: AppColors.inkMuted, fontSize: 14),
            ),
            const SizedBox(height: 24),
            _PitchTabBar(
              labels: _tabs,
              selected: _selected,
              onChanged: (i) => setState(() => _selected = i),
            ),
            const SizedBox(height: 24),
            if (_selected == 0)
              _OmniaPanel(isCompact: isCompact)
            else
              const _DeckIframePanel(
                url: _onlineTribesDeckUrl,
                viewType: _onlineTribesDeckViewType,
              ),
          ],
        ),
      ),
    );
  }
}

// ----- Tab bar -----------------------------------------------------------

class _PitchTabBar extends StatelessWidget {
  const _PitchTabBar({
    required this.labels,
    required this.selected,
    required this.onChanged,
  });

  final List<String> labels;
  final int selected;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    // Horizontal scroll on narrow screens — matches the "scroll enabled on
    // mobile" requirement; on wide screens content fits and never scrolls.
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Container(
        decoration: BoxDecoration(
          color: AppColors.cardBg,
          border: Border.all(color: AppColors.cardBorder),
          borderRadius: BorderRadius.circular(999),
        ),
        padding: const EdgeInsets.all(4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (var i = 0; i < labels.length; i++)
              _TabPill(
                label: labels[i],
                active: i == selected,
                onTap: () => onChanged(i),
              ),
          ],
        ),
      ),
    );
  }
}

class _TabPill extends StatelessWidget {
  const _TabPill({
    required this.label,
    required this.active,
    required this.onTap,
  });

  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
        decoration: BoxDecoration(
          color: active ? AppColors.accentSoft : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: active
                ? AppColors.accent.withValues(alpha: 0.5)
                : Colors.transparent,
          ),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: active ? AppColors.ink : AppColors.inkMuted,
            fontSize: 13,
            fontWeight: active ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }
}

// ----- Deck iframe panel -------------------------------------------------

// Loads a static HTML deck from web/decks/ via an HTMLIFrameElement bridged
// through HtmlElementView. Editing the HTML file is the entire update flow.
//
// Iframe height is capped at ~85vh so the deck takes most of the viewport but
// the surrounding chrome still scrolls naturally on the outer page.
class _DeckIframePanel extends StatefulWidget {
  const _DeckIframePanel({required this.url, required this.viewType});

  final String url;
  final String viewType;

  @override
  State<_DeckIframePanel> createState() => _DeckIframePanelState();
}

class _DeckIframePanelState extends State<_DeckIframePanel> {
  // registerViewFactory throws on a duplicate viewType, so dedupe across
  // panel instances (rebuilds, hot reload, multiple decks on screen, etc.).
  static final Set<String> _registered = {};

  @override
  void initState() {
    super.initState();
    if (_registered.add(widget.viewType)) {
      ui_web.platformViewRegistry.registerViewFactory(
        widget.viewType,
        (int viewId) {
          return web.HTMLIFrameElement()
            ..src = widget.url
            ..title = widget.viewType
            ..style.border = 'none'
            ..style.width = '100%'
            ..style.height = '100%'
            ..style.background = '#ffffff'
            ..style.borderRadius = '14px';
        },
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    // On phones the deck used to fill ~85% of the viewport, leaving no page
    // gutter to grab — so once the finger was over the iframe, scrolling the
    // outer page was nearly impossible. Cap it shorter on compact screens so
    // there's comfortable scrollable space above and below the embed.
    final isCompact = size.width < 760;
    final height = isCompact
        ? (size.height * 0.6).clamp(360.0, 680.0)
        : (size.height * 0.85).clamp(560.0, 1400.0);
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.cardBorder),
        boxShadow: const [
          BoxShadow(color: Colors.black26, blurRadius: 24, offset: Offset(0, 8)),
        ],
      ),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        height: height,
        child: HtmlElementView(viewType: widget.viewType),
      ),
    );
  }
}

// ----- Omnia panel: video + deck iframe ---------------------------------

class _OmniaPanel extends StatelessWidget {
  const _OmniaPanel({required this.isCompact});

  final bool isCompact;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: const [
        _YouTubeEmbed(videoId: _omniaYouTubeId, viewType: _omniaVideoViewType),
        SizedBox(height: 24),
        _DeckIframePanel(url: _omniaDeckUrl, viewType: _omniaDeckViewType),
      ],
    );
  }
}

// ----- YouTube embed ----------------------------------------------------

// Embeds a YouTube video via an HTMLIFrameElement bridged through
// HtmlElementView (same pattern as the deck panels). 16:9, rounded corners.
// registerViewFactory throws on a duplicate viewType, so dedupe across
// instances (rebuilds, hot reload) with a static set.
class _YouTubeEmbed extends StatefulWidget {
  const _YouTubeEmbed({required this.videoId, required this.viewType});

  final String videoId;
  final String viewType;

  @override
  State<_YouTubeEmbed> createState() => _YouTubeEmbedState();
}

class _YouTubeEmbedState extends State<_YouTubeEmbed> {
  static final Set<String> _registered = {};

  @override
  void initState() {
    super.initState();
    if (_registered.add(widget.viewType)) {
      ui_web.platformViewRegistry.registerViewFactory(
        widget.viewType,
        (int viewId) {
          return web.HTMLIFrameElement()
            ..src =
                'https://www.youtube-nocookie.com/embed/${widget.videoId}?rel=0'
            ..title = 'Omnia presentation'
            ..allow =
                'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
            ..allowFullscreen = true
            ..style.border = 'none'
            ..style.width = '100%'
            ..style.height = '100%'
            ..style.borderRadius = '14px'
            ..style.background = '#000000';
        },
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: HtmlElementView(viewType: widget.viewType),
      ),
    );
  }
}
