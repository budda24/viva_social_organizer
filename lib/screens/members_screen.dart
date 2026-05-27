// Directory — streams users/{*} where status == 'approved' and renders each
// as a profile card with photo, name, enriched bio + topics. The same fields
// the bot's buddy-matcher scores on, surfaced visually so members can browse
// before/while chatting with the bot.

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_theme.dart';
import '../widgets/app_scaffold.dart';

class MembersScreen extends StatelessWidget {
  const MembersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final width = MediaQuery.sizeOf(context).width;
    final isCompact = width < 940;

    final currentUid = FirebaseAuth.instance.currentUser?.uid;
    // PROTOTYPE: list every user doc that isn't explicitly opted-out. Old
    // sign-ups carry status='signed_in' (pre-auto-approve) — keep them
    // visible. Filter on `status != 'opted_out'` client-side because
    // Firestore can't do != on a missing field reliably across all docs.
    final stream =
        FirebaseFirestore.instance.collection('users').snapshots();

    return AppScaffold(
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: isCompact ? 20 : 40),
        child: Padding(
          padding: EdgeInsets.symmetric(vertical: isCompact ? 24 : 48),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'People',
                style: serif(fontSize: isCompact ? 38 : 56, weight: FontWeight.w500),
              ),
              const SizedBox(height: 8),
              const Text(
                'Members at VivaTech Paris 2026.',
                style: TextStyle(color: AppColors.inkMuted, fontSize: 14),
              ),
              const SizedBox(height: 28),
              // AppScaffold uses a SingleChildScrollView; Expanded is illegal
              // in that unbounded context. shrinkWrap+NeverScrollable lets the
              // grid take just the height it needs and the parent scroll
              // handles overflow.
              StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                stream: stream,
                builder: (context, snap) {
                  if (snap.connectionState == ConnectionState.waiting) {
                    return const _Loading();
                  }
                  if (snap.hasError) {
                    return _ErrorView(error: snap.error.toString());
                  }
                  final docs = (snap.data?.docs ?? const []).where((d) {
                    if (d.id == currentUid) return false;
                    final status = d.data()['status'] as String?;
                    return status != 'opted_out';
                  }).toList();
                  if (docs.isEmpty) {
                    return const _Empty();
                  }
                  final columns = width >= 1100
                      ? 3
                      : width >= 700
                          ? 2
                          : 1;
                  return GridView.builder(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    gridDelegate:
                        SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: columns,
                      mainAxisSpacing: 14,
                      crossAxisSpacing: 14,
                      childAspectRatio: 1.55,
                    ),
                    itemCount: docs.length,
                    itemBuilder: (_, i) => _MemberCard(doc: docs[i]),
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MemberCard extends StatelessWidget {
  const _MemberCard({required this.doc});

  final QueryDocumentSnapshot<Map<String, dynamic>> doc;

  @override
  Widget build(BuildContext context) {
    final d = doc.data();
    final name = (d['displayName'] as String?) ?? '';
    final photoUrl = (d['photoUrl'] as String?) ?? '';
    final email = (d['email'] as String?) ?? '';
    final enrichment = (d['enrichment'] is Map)
        ? Map<String, dynamic>.from(d['enrichment'] as Map)
        : const <String, dynamic>{};
    final bio = (enrichment['bio'] as String?) ??
        (d['bio'] as String?) ??
        '';
    final company = (enrichment['company'] as String?) ?? '';
    final topics = (enrichment['topics'] is List)
        ? (enrichment['topics'] as List).map((e) => e.toString()).toList()
        : <String>[];
    final enrichmentStatus = (enrichment['status'] as String?) ?? '';

    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: AppColors.cardBg,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: AppColors.cardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _Avatar(name: name, photoUrl: photoUrl, size: 44),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name.isEmpty ? '(unknown)' : name,
                      style: const TextStyle(
                        color: AppColors.ink,
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (company.isNotEmpty)
                      Text(
                        company,
                        style: const TextStyle(
                          color: AppColors.inkMuted,
                          fontSize: 12,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      )
                    else if (email.isNotEmpty)
                      Text(
                        email,
                        style: const TextStyle(
                          color: AppColors.inkSubtle,
                          fontSize: 11,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Expanded(
            child: bio.isNotEmpty
                ? Text(
                    bio,
                    style: const TextStyle(
                      color: AppColors.ink,
                      fontSize: 13,
                      height: 1.4,
                    ),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  )
                : Text(
                    enrichmentStatus == 'pending' ||
                            enrichmentStatus == 'running'
                        ? 'Profile loading…'
                        : 'No bio yet.',
                    style: const TextStyle(
                      color: AppColors.inkSubtle,
                      fontSize: 12,
                      fontStyle: FontStyle.italic,
                    ),
                  ),
          ),
          if (topics.isNotEmpty) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final t in topics.take(4)) _TopicChip(label: t),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({required this.name, required this.photoUrl, this.size = 44});

  final String name;
  final String photoUrl;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (photoUrl.isEmpty) return _initial();
    return ClipOval(
      child: Image.network(
        photoUrl,
        width: size,
        height: size,
        fit: BoxFit.cover,
        errorBuilder: (_, _, _) => _initial(),
      ),
    );
  }

  Widget _initial() {
    return Container(
      width: size,
      height: size,
      decoration: const BoxDecoration(
        color: AppColors.accentSoft,
        shape: BoxShape.circle,
      ),
      alignment: Alignment.center,
      child: Text(
        name.isEmpty ? '?' : name.characters.first.toUpperCase(),
        style: TextStyle(
          color: AppColors.ink,
          fontWeight: FontWeight.w600,
          fontSize: size * 0.42,
        ),
      ),
    );
  }
}

class _TopicChip extends StatelessWidget {
  const _TopicChip({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.accentSoft,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        label,
        style: const TextStyle(
          color: AppColors.accent,
          fontSize: 11,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _Loading extends StatelessWidget {
  const _Loading();

  @override
  Widget build(BuildContext context) => Container(
        height: 240,
        alignment: Alignment.center,
        child: const SizedBox(
          width: 24,
          height: 24,
          child: CircularProgressIndicator(
            strokeWidth: 2,
            color: AppColors.accent,
          ),
        ),
      );
}

class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 240,
      alignment: Alignment.center,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: const [
          Text(
            'Nobody else here yet.',
            style: TextStyle(color: AppColors.ink, fontSize: 18),
          ),
          SizedBox(height: 8),
          Text(
            'People appear here once they sign in with LinkedIn.',
            style: TextStyle(color: AppColors.inkMuted, fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.error});

  final String error;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 240,
      alignment: Alignment.center,
      padding: const EdgeInsets.all(24),
      child: Text(
        'Couldn\'t load directory: $error',
        style: const TextStyle(color: Colors.red, fontSize: 13),
        textAlign: TextAlign.center,
      ),
    );
  }
}
