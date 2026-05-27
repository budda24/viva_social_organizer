import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import 'online_tribes_logo.dart';

class TopBar extends StatelessWidget {
  const TopBar({super.key, this.trailing});

  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final isCompact = MediaQuery.sizeOf(context).width < 640;
    // Rebuild on auth changes so nav links appear/disappear instantly when
    // the user signs in or out — no manual setState needed by parents.
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      initialData: FirebaseAuth.instance.currentUser,
      builder: (context, snap) {
        final signedIn = snap.data != null;
        final currentRoute = ModalRoute.of(context)?.settings.name ?? '';
        return Padding(
          padding: EdgeInsets.symmetric(
            horizontal: isCompact ? 20 : 40,
            vertical: 24,
          ),
          child: Row(
            children: [
              InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: () => Navigator.of(context).pushReplacementNamed(
                  signedIn ? '/welcome' : '/',
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: const [
                    OnlineTribesLogo(),
                    SizedBox(width: 10),
                    Text(
                      'Online Tribes',
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        fontSize: 15,
                        color: AppColors.ink,
                      ),
                    ),
                  ],
                ),
              ),
              if (!isCompact) ...[
                const SizedBox(width: 20),
                Container(width: 1, height: 18, color: AppColors.divider),
                const SizedBox(width: 20),
                const Text(
                  'VIVA TRIBE  ·  17-20 JUNE 2026',
                  style: TextStyle(
                    fontSize: 11,
                    letterSpacing: 1.3,
                    color: AppColors.inkMuted,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
              if (signedIn) ...[
                const SizedBox(width: 28),
                _NavLink(
                  label: 'Welcome',
                  route: '/welcome',
                  active: currentRoute == '/welcome',
                ),
                const SizedBox(width: 18),
                _NavLink(
                  label: 'People',
                  route: '/members',
                  active: currentRoute == '/members',
                ),
              ],
              const Spacer(),
              ?trailing,
            ],
          ),
        );
      },
    );
  }
}

class _NavLink extends StatelessWidget {
  const _NavLink({
    required this.label,
    required this.route,
    required this.active,
  });

  final String label;
  final String route;
  final bool active;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(6),
      onTap: active
          ? null
          : () => Navigator.of(context).pushReplacementNamed(route),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
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
