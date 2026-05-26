import '../models/attendee.dart';
import '../models/matched_human.dart';
import '../models/speaker.dart';

const sampleSpeakers = <Speaker>[
  Speaker(name: 'Yann LeCun', role: 'AI · KEYNOTE'),
  Speaker(name: 'Bernard Arnault', role: 'LVMH · FIRESIDE'),
  Speaker(name: 'Christel Heydemann', role: 'ORANGE · PANEL'),
  Speaker(name: 'Shantanu Narayen', role: 'ADOBE · KEYNOTE'),
  Speaker(name: 'Henna Virkkunen', role: 'EU COMMISSION'),
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
