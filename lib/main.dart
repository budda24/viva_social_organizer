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
      initialRoute: '/',
      routes: {
        '/': (_) => const LandingScreen(),
        '/in': (_) => const InviteScreen(),
        '/auth/linkedin/callback': (_) => const LinkedInCallbackScreen(),
        '/welcome': (context) {
          final args = ModalRoute.of(context)?.settings.arguments;
          return WelcomeScreen(
            inviteCode: args is String ? args : 'VIVA-26-LK7',
          );
        },
      },
    );
  }
}
