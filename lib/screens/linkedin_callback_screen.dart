// Landing page for LinkedIn's OAuth redirect. URL looks like:
//   https://viva-social-organizer.web.app/auth/linkedin/callback?code=…&state=…
//
// We read the `code` query param, send it to the `linkedinSignIn` Cloud
// Function (which exchanges it for tokens and mints a Firebase custom token),
// then call signInWithCustomToken to complete sign-in client-side and route
// to /welcome.
//
// Custom-token flow exists because Firebase Auth's built-in OIDC handler is
// incompatible with LinkedIn — see comment in functions/src/users/linkedin.ts.

import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

// LinkedIn sends us back here with ?error=… when the user backs out of the
// consent screen or it fails. Turn those raw OAuth codes into a human message.
// The cancel codes below are what LinkedIn / the OAuth spec emit when the user
// clicks "Cancel" rather than "Allow".
String _friendlyLinkedInError(String err, [String? desc]) {
  const cancelCodes = {
    'user_cancelled_login',
    'user_cancelled_authorize',
    'access_denied',
  };
  if (cancelCodes.contains(err)) {
    return 'No problem — LinkedIn sign-in was cancelled. '
        'Tap below whenever you’re ready to try again.';
  }
  final detail = (desc != null && desc.isNotEmpty) ? ' ($desc)' : '';
  return 'LinkedIn sign-in didn’t go through$detail. Tap below to try again.';
}

class LinkedInCallbackScreen extends StatefulWidget {
  const LinkedInCallbackScreen({super.key});

  @override
  State<LinkedInCallbackScreen> createState() => _LinkedInCallbackScreenState();
}

class _LinkedInCallbackScreenState extends State<LinkedInCallbackScreen> {
  String? _error;

  @override
  void initState() {
    super.initState();
    // Defer one frame so Navigator is ready (we may pushReplacementNamed).
    WidgetsBinding.instance.addPostFrameCallback((_) => _exchange());
  }

  Future<void> _exchange() async {
    final uri = Uri.base;
    final code = uri.queryParameters['code'];
    final ldErr = uri.queryParameters['error'];
    final ldErrDesc = uri.queryParameters['error_description'];

    if (ldErr != null) {
      setState(() => _error = _friendlyLinkedInError(ldErr, ldErrDesc));
      return;
    }
    if (code == null || code.isEmpty) {
      setState(() => _error = 'Missing authorization code in callback URL.');
      return;
    }

    try {
      // The redirect_uri sent now must byte-match the one we sent on the
      // initial auth request, or LinkedIn rejects the token exchange.
      final redirectUri = '${uri.origin}/auth/linkedin/callback';

      final callable = FirebaseFunctions.instanceFor(region: 'europe-central2')
          .httpsCallable('linkedinSignIn');
      final res = await callable.call(<String, String>{
        'code': code,
        'redirectUri': redirectUri,
      });

      final data = Map<String, dynamic>.from(res.data as Map);
      final token = data['customToken'] as String?;
      if (token == null) {
        setState(() => _error = 'No custom token returned.');
        return;
      }

      await FirebaseAuth.instance.signInWithCustomToken(token);

      if (!mounted) return;
      Navigator.of(context).pushReplacementNamed(
        '/welcome',
        arguments: 'VIVA-26-LK7',
      );
    } on FirebaseFunctionsException catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Sign-in failed: ${e.message ?? e.code}');
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Sign-in failed: $e');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Center(
        child: _error != null
            ? Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      _error!,
                      style: const TextStyle(color: Colors.red, fontSize: 14),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 24),
                    TextButton(
                      onPressed: () => Navigator.of(context)
                          .pushReplacementNamed('/in'),
                      child: const Text('Back to sign in'),
                    ),
                  ],
                ),
              )
            : const Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 28,
                    height: 28,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: AppColors.accent,
                    ),
                  ),
                  SizedBox(height: 16),
                  Text(
                    'Signing you in…',
                    style: TextStyle(color: AppColors.inkMuted, fontSize: 14),
                  ),
                ],
              ),
      ),
    );
  }
}
