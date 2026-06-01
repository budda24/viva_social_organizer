// Pitches — two tabs, each rendering an HTML pitch deck inside an iframe.
// Editing the HTML files under web/decks/ is the whole update flow; no Dart
// changes needed when the deck content shifts.
//
// Layout: title + pill tab bar + active panel. Omnia also gets a video player
// (pitch_2.mp4) above its deck; Online Tribes' video lands later.

import 'dart:developer' as developer;
import 'dart:ui_web' as ui_web;

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:web/web.dart' as web;

import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';

const _onlineTribesDeckUrl = 'decks/online-tribes.html';
const _onlineTribesDeckViewType = 'deck-online-tribes';

const _omniaDeckUrl = 'decks/omnia.html';
const _omniaDeckViewType = 'deck-omnia';

// Served as a static file from web/videos/ via Firebase Hosting. Loaded with
// an absolute path so the browser doesn't resolve it relative to the current
// route (e.g. /pitches/videos/... → catch-all rewrite → broken video).
const _omniaVideoUrl = '/videos/pitch_2.mp4';

class PitchesScreen extends StatefulWidget {
  const PitchesScreen({super.key});

  @override
  State<PitchesScreen> createState() => _PitchesScreenState();
}

class _PitchesScreenState extends State<PitchesScreen> {
  int _selected = 0;

  static const _tabs = ['Online Tribes', 'Omnia'];

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
              const _DeckIframePanel(
                url: _onlineTribesDeckUrl,
                viewType: _onlineTribesDeckViewType,
              )
            else
              _OmniaPanel(isCompact: isCompact),
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
    final height = (size.height * 0.85).clamp(560.0, 1400.0);
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
        _NetworkVideoPlayer(url: _omniaVideoUrl),
        SizedBox(height: 24),
        _DeckIframePanel(url: _omniaDeckUrl, viewType: _omniaDeckViewType),
      ],
    );
  }
}

// ----- Asset video player -----------------------------------------------

// Network-backed video player. 16:9, tap-to-toggle, with a thin scrubber.
// Loading from a static URL (vs Flutter asset) avoids the relative-path trap
// on Firebase Hosting where `assets/...` resolves under the current route and
// gets caught by the catch-all rewrite. Initialization is async; we render a
// black frame + spinner until it's ready, so the layout never jumps.
class _NetworkVideoPlayer extends StatefulWidget {
  const _NetworkVideoPlayer({required this.url});

  final String url;

  @override
  State<_NetworkVideoPlayer> createState() => _NetworkVideoPlayerState();
}

class _NetworkVideoPlayerState extends State<_NetworkVideoPlayer> {
  late final VideoPlayerController _controller;
  bool _ready = false;
  bool _failed = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    // Resolve relative to the document origin so the URL is always absolute,
    // regardless of which route the user is on. Without this, a relative path
    // (or a leading-slash path interpreted oddly by the platform) can fall
    // through to Firebase Hosting's catch-all rewrite and 404 as index.html.
    final resolved = Uri.base.resolve(widget.url);
    _controller = VideoPlayerController.networkUrl(resolved)
      ..setLooping(false)
      ..addListener(_onTick);
    _controller.initialize().then((_) {
      if (mounted) setState(() => _ready = true);
    }).catchError((Object err) {
      developer.log(
        'Video init failed for $resolved: $err',
        name: 'pitches_screen',
        error: err,
      );
      if (mounted) {
        setState(() {
          _failed = true;
          _error = err.toString();
        });
      }
    });
  }

  void _onTick() {
    if (!mounted) return;
    // Cheap rebuild — the player surface needs to reflect play/pause state and
    // scrubber position. VideoPlayerController only emits a notify on actual
    // changes, so this isn't burning frames at idle.
    setState(() {});
  }

  @override
  void dispose() {
    _controller.removeListener(_onTick);
    _controller.dispose();
    super.dispose();
  }

  void _toggle() {
    if (!_ready) return;
    if (_controller.value.isPlaying) {
      _controller.pause();
    } else {
      _controller.play();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_failed) {
      return _VideoPlaceholder(
        assetPath: widget.url,
        lengthLabel: 'unavailable',
        error: _error,
      );
    }
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: GestureDetector(
          onTap: _toggle,
          child: Stack(
            fit: StackFit.expand,
            children: [
              Container(color: Colors.black),
              if (_ready)
                FittedBox(
                  fit: BoxFit.contain,
                  child: SizedBox(
                    width: _controller.value.size.width,
                    height: _controller.value.size.height,
                    child: VideoPlayer(_controller),
                  ),
                ),
              if (!_ready)
                const Center(
                  child: SizedBox(
                    width: 28,
                    height: 28,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppColors.accent,
                    ),
                  ),
                ),
              if (_ready && !_controller.value.isPlaying) _PlayOverlay(),
              if (_ready)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: VideoProgressIndicator(
                    _controller,
                    allowScrubbing: true,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 6,
                    ),
                    colors: const VideoProgressColors(
                      playedColor: AppColors.accent,
                      bufferedColor: Color(0x44A78BFA),
                      backgroundColor: Color(0x22FFFFFF),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PlayOverlay extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withValues(alpha: 0.25),
      alignment: Alignment.center,
      child: Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          color: AppColors.accentSoft,
          shape: BoxShape.circle,
          border: Border.all(color: AppColors.accent.withValues(alpha: 0.6)),
        ),
        alignment: Alignment.center,
        child: const Padding(
          padding: EdgeInsets.only(left: 4),
          child: Icon(
            Icons.play_arrow_rounded,
            color: AppColors.ink,
            size: 34,
          ),
        ),
      ),
    );
  }
}

// ----- Video placeholder (used when video fails to load) ----------------

class _VideoPlaceholder extends StatelessWidget {
  const _VideoPlaceholder({
    required this.assetPath,
    this.lengthLabel,
    this.error,
  });

  final String assetPath;
  final String? lengthLabel;
  final String? error;

  @override
  Widget build(BuildContext context) {
    return AspectRatio(
      aspectRatio: 16 / 9,
      child: Container(
        decoration: BoxDecoration(
          gradient: const LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [AppColors.backgroundGlow, AppColors.background],
          ),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: AppColors.surfaceTintBorder),
        ),
        child: Stack(
          children: [
            Center(
              child: Container(
                width: 64,
                height: 64,
                decoration: BoxDecoration(
                  color: AppColors.accentSoft,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: AppColors.accent.withValues(alpha: 0.6),
                  ),
                ),
                alignment: Alignment.center,
                child: const Padding(
                  padding: EdgeInsets.only(left: 4),
                  child: Icon(
                    Icons.play_arrow_rounded,
                    color: AppColors.ink,
                    size: 34,
                  ),
                ),
              ),
            ),
            if (error != null)
              Positioned(
                left: 14,
                right: 14,
                bottom: 38,
                child: Text(
                  error!,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFFF87171),
                    fontSize: 11,
                    height: 1.4,
                  ),
                ),
              ),
            if (lengthLabel != null)
              Positioned(
                left: 14,
                bottom: 12,
                child: _Chip(
                  child: Text(
                    'Video · $lengthLabel',
                    style: const TextStyle(
                      color: AppColors.inkMuted,
                      fontSize: 11,
                      fontWeight: FontWeight.w500,
                      letterSpacing: 0.4,
                    ),
                  ),
                ),
              ),
            Positioned(
              left: 14,
              top: 12,
              child: _Chip(
                child: Text(
                  assetPath,
                  style: mono(
                    fontSize: 9,
                    color: AppColors.inkSubtle,
                    weight: FontWeight.w500,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.background.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: AppColors.cardBorder),
      ),
      child: child,
    );
  }
}
