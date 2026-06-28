import 'package:flutter/material.dart';
import 'package:simple_icons/simple_icons.dart';

/// Brand-accurate WhatsApp & Telegram marks: the official Simple Icons glyph
/// rendered white on a brand-coloured disc, so each reads like the real app
/// icon. Sized to drop straight into a 40×40 leading slot on the landing cards.

class WhatsAppLogo extends StatelessWidget {
  const WhatsAppLogo({super.key, this.size = 40});

  final double size;

  @override
  Widget build(BuildContext context) {
    return _BrandDisc(
      size: size,
      glyph: SimpleIcons.whatsapp,
      // Flat WhatsApp brand green.
      decoration: const BoxDecoration(
        color: Color(0xFF25D366),
        shape: BoxShape.circle,
      ),
    );
  }
}

class TelegramLogo extends StatelessWidget {
  const TelegramLogo({super.key, this.size = 40});

  final double size;

  @override
  Widget build(BuildContext context) {
    return _BrandDisc(
      size: size,
      glyph: SimpleIcons.telegram,
      // Telegram's signature top-to-bottom blue gradient.
      decoration: const BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Color(0xFF2AABEE), Color(0xFF229ED9)],
        ),
      ),
    );
  }
}

/// A brand-coloured disc with a white glyph centred in it.
class _BrandDisc extends StatelessWidget {
  const _BrandDisc({
    required this.size,
    required this.glyph,
    required this.decoration,
  });

  final double size;
  final IconData glyph;
  final BoxDecoration decoration;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: decoration,
      alignment: Alignment.center,
      child: Icon(glyph, size: size * 0.52, color: Colors.white),
    );
  }
}
