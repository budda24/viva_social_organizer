import 'package:flutter/material.dart';

void main() {
  runApp(const VivaSocialApp());
}

class VivaSocialApp extends StatelessWidget {
  const VivaSocialApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Founders & Builders @ VivaTech',
      debugShowCheckedModeBanner: false,
      theme: _buildTheme(),
      home: const _PlaceholderScreen(),
    );
  }
}

ThemeData _buildTheme() {
  const ink = Color(0xFF1F1D1A);
  const bg = Color(0xFFFAF7F2);
  const accent = Color(0xFFC9522B);

  return ThemeData(
    colorScheme: ColorScheme.fromSeed(
      seedColor: accent,
      brightness: Brightness.light,
      surface: bg,
      onSurface: ink,
    ),
    scaffoldBackgroundColor: bg,
    textTheme: const TextTheme(
      displayMedium: TextStyle(
        fontWeight: FontWeight.w600,
        color: ink,
        height: 1.1,
      ),
      bodyLarge: TextStyle(color: ink, height: 1.55),
      bodyMedium: TextStyle(color: ink, height: 1.55),
    ),
    useMaterial3: true,
  );
}

class _PlaceholderScreen extends StatelessWidget {
  const _PlaceholderScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Une petite circle of founders à Paris.',
                  style: TextStyle(
                    fontStyle: FontStyle.italic,
                    color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.55),
                  ),
                ),
                const SizedBox(height: 24),
                Text(
                  'Founders & Builders\n@ VivaTech 2026',
                  style: Theme.of(context).textTheme.displayMedium?.copyWith(fontSize: 42),
                ),
                const SizedBox(height: 24),
                Text(
                  'Member portal — coming soon.\n\n'
                  'If you have an invite code, you will be redirected here after signing in with LinkedIn.',
                  style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                      ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
