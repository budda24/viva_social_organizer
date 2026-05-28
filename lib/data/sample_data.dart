import '../models/attendee.dart';
import '../models/event.dart';
import '../models/matched_human.dart';
import '../models/speaker.dart';

const sampleSpeakers = <Speaker>[
  Speaker(
    name: 'Bernard Arnault',
    role: 'LVMH · FIRESIDE',
    imageUrl: 'assets/speakers/arnault.jpg',
  ),
  Speaker(
    name: 'Jensen Huang',
    role: 'NVIDIA · KEYNOTE',
    imageUrl: 'assets/speakers/huang.jpg',
  ),
  Speaker(
    name: 'Yann LeCun',
    role: 'AI · KEYNOTE',
    imageUrl: 'assets/speakers/lecun.jpg',
  ),
  Speaker(
    name: 'Shantanu Narayen',
    role: 'ADOBE · KEYNOTE',
    imageUrl: 'assets/speakers/narayen.jpg',
  ),
  Speaker(
    name: 'Léon Marchand',
    role: 'LVMH · AMBASSADOR',
    imageUrl: 'assets/speakers/marchand.jpg',
  ),
  Speaker(
    name: 'Christel Heydemann',
    role: 'ORANGE · PANEL',
    imageUrl: 'assets/speakers/heydemann.jpg',
  ),
  Speaker(
    name: 'Roland Busch',
    role: 'SIEMENS · KEYNOTE',
    imageUrl: 'assets/speakers/busch.jpg',
  ),
  Speaker(
    name: 'Henna Virkkunen',
    role: 'EU COMMISSION',
    imageUrl: 'assets/speakers/virkkunen.jpg',
  ),
  Speaker(
    name: 'Octave Klaba',
    role: 'OVHCLOUD · FIRESIDE',
    imageUrl: 'assets/speakers/klaba.jpg',
  ),
];

const sampleAttendees = <Attendee>[
  Attendee(
    name: 'Léa Mercier',
    description: 'scope-3 carbon for industrials',
    location: 'BERLIN → PARIS',
  ),
  Attendee(
    name: 'Marcus Højlund',
    description: 'boutique European fund · early-stage',
    location: 'COPENHAGEN',
  ),
  Attendee(
    name: 'Yuki Tanaka',
    description: 'agentic CRM, solo, week 7',
    location: 'TOKYO → PARIS',
  ),
  Attendee(
    name: 'Tom Adebayo',
    description: 'evals infra for production agents',
    location: 'LONDON',
  ),
];

const sampleEvents = <Event>[
  Event(
    emoji: '🥐',
    title: 'Breakfast meet',
    day: 'WED · 17 JUN',
    organizer: 'Léa Mercier',
  ),
  Event(
    emoji: '🏃',
    title: 'Morning run · Seine',
    day: 'THU · 18 JUN',
    organizer: 'Marcus Højlund',
  ),
  Event(
    emoji: '🎤',
    title: 'Lightning demos',
    day: 'THU · 18 JUN',
    organizer: 'Tom Adebayo',
  ),
  Event(
    emoji: '🍷',
    title: 'Wine + agents',
    day: 'THU · 18 JUN',
    organizer: 'Yuki Tanaka',
  ),
  Event(
    emoji: '🚶',
    title: 'Walk to LeCun keynote',
    day: 'FRI · 19 JUN',
    organizer: 'Yuki Tanaka',
  ),
  Event(
    emoji: '☕',
    title: 'Founders coffee',
    day: 'FRI · 19 JUN',
    organizer: 'Léa Mercier',
  ),
  Event(
    emoji: '🥗',
    title: 'Late lunch · Le Marais',
    day: 'FRI · 19 JUN',
    organizer: 'Marcus Højlund',
  ),
  Event(
    emoji: '🌃',
    title: 'After-party warm-up',
    day: 'SAT · 20 JUN',
    organizer: 'Tom Adebayo',
  ),
];

const sampleMatchedHumans = <MatchedHuman>[
  MatchedHuman(
    name: 'Marcus Højlund',
    city: 'COPENHAGEN',
    description: 'boutique European fund · early-stage',
  ),
  MatchedHuman(
    name: 'Jules Bertrand',
    city: 'PARIS',
    description: 'photonic chips for inference',
  ),
  MatchedHuman(
    name: 'Henrik Voss',
    city: 'STOCKHOLM',
    description: 'ex-Spotify · 14 angel cheques',
  ),
  MatchedHuman(
    name: 'Tom Adebayo',
    city: 'LONDON',
    description: 'evals infra for production agents',
  ),
  MatchedHuman(
    name: 'Ana Ferreira',
    city: 'LISBON',
    description: 'second-hand luxury · auth & resale',
  ),
];
