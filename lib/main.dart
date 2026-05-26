import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'firebase_options.dart';
import 'screens/invite_screen.dart';
import 'screens/landing_screen.dart';
import 'screens/linkedin_callback_screen.dart';
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
            return MaterialPageRoute(builder: (_) => const LandingScreen());
          case '/in':
            return MaterialPageRoute(builder: (_) => const InviteScreen());
          case '/auth/linkedin/callback':
            return MaterialPageRoute(builder: (_) => const LinkedInCallbackScreen());
          case '/welcome':
            final args = settings.arguments;
            return MaterialPageRoute(
              builder: (_) => WelcomeScreen(
                inviteCode: args is String ? args : 'VIVA-26-LK7',
              ),
            );
          default:
            // Unknown path — show landing instead of a Flutter error screen.
            return MaterialPageRoute(builder: (_) => const LandingScreen());
        }
      },
    );
  }
}
