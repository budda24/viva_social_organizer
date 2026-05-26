import 'package:flutter/material.dart';

class OnlineTribesLogo extends StatelessWidget {
  const OnlineTribesLogo({super.key, this.size = 26});

  final double size;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(size * 0.22),
      child: Image.asset(
        'assets/online_tribes_logo.jpeg',
        width: size,
        height: size,
        fit: BoxFit.cover,
        filterQuality: FilterQuality.medium,
      ),
    );
  }
}
