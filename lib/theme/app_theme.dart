import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'app_colors.dart';

ThemeData buildAppTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  final textTheme = GoogleFonts.interTextTheme(base.textTheme).apply(
    bodyColor: AppColors.ink,
    displayColor: AppColors.ink,
  );

  return base.copyWith(
    scaffoldBackgroundColor: AppColors.background,
    colorScheme: ColorScheme.fromSeed(
      seedColor: AppColors.accent,
      brightness: Brightness.dark,
      surface: AppColors.background,
      onSurface: AppColors.ink,
      primary: AppColors.accent,
      onPrimary: AppColors.accentInk,
    ),
    textTheme: textTheme,
    dividerColor: AppColors.divider,
    splashFactory: InkSparkle.splashFactory,
  );
}

TextStyle serif({
  required double fontSize,
  FontWeight weight = FontWeight.w500,
  FontStyle style = FontStyle.normal,
  Color? color,
  double height = 1.05,
  double letterSpacing = -0.5,
}) {
  return GoogleFonts.fraunces(
    fontSize: fontSize,
    fontWeight: weight,
    fontStyle: style,
    color: color ?? AppColors.ink,
    height: height,
    letterSpacing: letterSpacing,
  );
}

TextStyle mono({double fontSize = 12, Color? color, FontWeight weight = FontWeight.w600}) {
  return GoogleFonts.jetBrainsMono(
    fontSize: fontSize,
    color: color ?? AppColors.ink,
    fontWeight: weight,
    letterSpacing: 1.1,
  );
}
