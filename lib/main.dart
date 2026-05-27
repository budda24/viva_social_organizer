import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'firebase_options.dart';
import 'screens/invite_screen.dart';
import 'screens/landing_screen.dart';
import 'screens/linkedin_callback_screen.dart';
import 'screens/members_screen.dart';
import 'screens/welcome_screen.dart';
import 'theme/app_theme.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Path-based URLs (no leading "#") — required so LinkedIn can redirect to
  // /auth/linkedin/callback with a clean URI that matches what we registered
  // in the LinkedIn dev portal.
  usePathUrlStrategy();
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
  runApp(const VivaTribeApp());
}

class VivaTribeApp extends StatelessWidget {
  const VivaTribeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Viva Tribe · VivaTech 2026',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      // onGenerateRoute instead of `routes:` so nested paths like
      // `/auth/linkedin/callback` resolve to a single screen without
      // Flutter trying to build an intermediate `/auth` and `/auth/linkedin`
      // stack (which falls back to `/` when those segments aren't registered).
      initialRoute: '/',
      onGenerateRoute: (settings) {
        final name = settings.name ?? '/';
        // Strip any query string for matching — Flutter passes the raw URL.
        final path = name.split('?').first;
        switch (path) {
          case '/':
            return _fadeThrough(settings, (_) => const LandingScreen());
          case '/in':
            return _fadeThrough(settings, (_) => const InviteScreen());
          case '/auth/linkedin/callback':
            return _fadeThrough(
                settings, (_) => const LinkedInCallbackScreen());
          case '/welcome':
            final args = settings.arguments;
            return _fadeThrough(
              settings,
              (_) => WelcomeScreen(
                inviteCode: args is String ? args : 'VIVA-26-LK7',
              ),
            );
          case '/members':
            return _fadeThrough(settings, (_) => const MembersScreen());
          default:
            // Unknown path — show landing instead of a Flutter error screen.
            return _fadeThrough(settings, (_) => const LandingScreen());
        }
      },
    );
  }
}

// Material 3 "fade through" transition — old screen fades out + drops slightly,
// new screen fades in + rises slightly. Quick (260ms) and direction-agnostic,
// which suits web where there's no physical left/right semantic.
PageRoute<T> _fadeThrough<T>(RouteSettings settings, WidgetBuilder builder) {
  return PageRouteBuilder<T>(
    settings: settings,
    pageBuilder: (context, anim, _) => builder(context),
    transitionDuration: const Duration(milliseconds: 260),
    reverseTransitionDuration: const Duration(milliseconds: 180),
    transitionsBuilder: (context, anim, secondary, child) {
      final curved = CurvedAnimation(parent: anim, curve: Curves.easeOutCubic);
      final outgoing =
          CurvedAnimation(parent: secondary, curve: Curves.easeInCubic);
      final slideIn = Tween(begin: const Offset(0, 0.014), end: Offset.zero)
          .animate(curved);
      final slideOut = Tween(begin: Offset.zero, end: const Offset(0, -0.008))
          .animate(outgoing);
      return SlideTransition(
        position: slideOut,
        child: FadeTransition(
          opacity: ReverseAnimation(outgoing),
          child: FadeTransition(
            opacity: curved,
            child: SlideTransition(position: slideIn, child: child),
          ),
        ),
      );
    },
  );
}
