import 'dart:convert';
import 'dart:io';

import 'package:puzzle_duel_rules/puzzle_duel_rules.dart';

/// Stage D Dart fixture runner. Reads one fixture JSON from argv[1], prints JSON.
void main(List<String> args) {
  if (args.isEmpty) {
    stderr.writeln('usage: run_fixture.dart <fixture.json>');
    exit(2);
  }
  final doc =
      jsonDecode(File(args.first).readAsStringSync()) as Map<String, Object?>;
  final kind = doc['kind'] as String? ?? 'fullMove';
  try {
    final out = <String, Object?>{
      'engine': 'dart',
      'rulesPackage': 'puzzle_duel_rules',
      'id': doc['id'],
      'kind': kind,
    };
    switch (kind) {
      case 'hashOnly':
        _hashOnly(doc, out);
        break;
      case 'parseOnly':
        _parseOnly(doc, out);
        break;
      case 'replaySecurity':
        _replaySecurity(doc, out);
        break;
      default:
        _fullMove(doc, out);
    }
    stdout.write(jsonEncode(out));
  } on ValidationFailure catch (e) {
    stdout.write(
      jsonEncode({
        'engine': 'dart',
        'id': doc['id'],
        'ok': false,
        'codes': e.wires,
      }),
    );
  }
}

void _hashOnly(Map<String, Object?> doc, Map<String, Object?> out) {
  if (doc['id'] == 'V3-51') {
    final atoms = <Map<String, String>>[];
    const vectors = <(String, Object?)>[
      ('CV-01', <String, Object?>{}),
      ('CV-02', {'kind': 'spent'}),
      ('CV-03', {'kind': 'piece', 'shape': 'circle', 'direction': 'up'}),
      ('CV-04', null),
      ('CV-05', 0),
      ('CV-06', 900),
      ('CV-07', 'ended'),
      ('CV-08', 'a"b'),
      ('CV-09', r'a\b'),
    ];
    for (final (id, value) in vectors) {
      final c = canonicalJsonV3(value);
      atoms.add({'id': id, 'canonicalJson': c, 'sha256': sha256HexOfUtf8(c)});
    }
    out['ok'] = true;
    out['atoms'] = atoms;
    return;
  }
  final state = parseGameState(doc['state']);
  out['ok'] = true;
  out['stateHash'] = stateHashV3(state);
  out['canonicalJson'] = canonicalJsonV3(state.toJson());
}

void _parseOnly(Map<String, Object?> doc, Map<String, Object?> out) {
  final initial = doc['initial'] == true;
  try {
    final state = initial
        ? parseInitialGameState(doc['state'])
        : parseGameState(doc['state']);
    out['ok'] = true;
    out['state'] = state.toJson();
    out['stateHash'] = stateHashV3(state);
  } on ValidationFailure catch (e) {
    out['ok'] = false;
    out['codes'] = e.wires;
  }
}

void _fullMove(Map<String, Object?> doc, Map<String, Object?> out) {
  final requireInitial = doc['requireInitial'] != false;
  final initialRaw = doc['initialState'];
  final GameState state;
  try {
    state = requireInitial
        ? parseInitialGameState(initialRaw)
        : parseGameState(initialRaw);
  } on ValidationFailure catch (e) {
    out['ok'] = false;
    out['reason'] = 'invalid_initial';
    out['codes'] = e.wires;
    return;
  }
  final moves = (doc['moves'] as List<Object?>?) ?? const [];
  if (moves.isEmpty &&
      doc['expected'] is Map &&
      (doc['expected'] as Map)['ok'] == false) {
    // single-move negative may still list moves
  }
  final applied = <Map<String, Object?>>[];
  var current = state;
  for (final raw in moves) {
    final move = parseMove(raw);
    final result = applyMove(current, move);
    if (result is MoveRejected) {
      out['ok'] = false;
      out['result'] = {'kind': 'rejected', 'code': result.code.wire};
      out['state'] = result.state.toJson();
      return;
    }
    if (result is MoveUnsafe) {
      out['ok'] = false;
      out['result'] = {'kind': 'unsafe', 'reason': result.reason.wire};
      out['state'] = result.state.toJson();
      return;
    }
    final appliedMove = result as MoveApplied;
    applied.add({
      'landing': appliedMove.landing.toJson(),
      'turnsUsed': appliedMove.turnsUsed,
      'scoreDelta': appliedMove.scoreDelta,
      'waves': [for (final w in appliedMove.waves) w.toJson()],
      'finalState': appliedMove.finalState.toJson(),
      'stateHash': stateHashV3(appliedMove.finalState),
    });
    current = appliedMove.finalState;
  }
  out['ok'] = true;
  out['finalState'] = current.toJson();
  out['stateHash'] = stateHashV3(current);
  out['canonicalJson'] = canonicalJsonV3(current.toJson());
  out['applied'] = applied;
}

void _replaySecurity(Map<String, Object?> doc, Map<String, Object?> out) {
  final id = doc['id'];
  if (id == 'V3-46') {
    final a = _replay(doc['trustedInitial'], doc['movesA'] as List<Object?>);
    final b = _replay(doc['trustedInitial'], doc['movesB'] as List<Object?>);
    out['ok'] = true;
    out['hashA'] = a['stateHash'];
    out['hashB'] = b['stateHash'];
    out['hashesDiffer'] = a['stateHash'] != b['stateHash'];
    return;
  }
  if (id == 'V3-45') {
    final replayed = _replay(doc['trustedInitial'], const []);
    final claimed = parseGameState(doc['claimedSnapshot']);
    out['ok'] = true;
    out['replayFinalDiffersFromClaimed'] =
        jsonEncode(replayed['finalState']) != jsonEncode(claimed.toJson());
    return;
  }
  if (id == 'V3-42' || id == 'V3-43') {
    final moves = (doc['moves'] as List<Object?>?) ?? const <Object?>[];
    final replayed = _replay(doc['trustedInitial'], moves);
    if (replayed['ok'] != true) {
      out['ok'] = false;
      out['replayOk'] = false;
      return;
    }
    final finalState = parseGameState(replayed['finalState']);
    final authentic = finalState.toJson();
    final report = Map<String, Object?>.from(doc['clientReport'] as Map);
    final client = id == 'V3-42'
        ? <String, Object?>{
            ...report,
            'board': authentic['cells'],
            'offers': authentic['offers'],
            'turnsUsed': authentic['turnsUsed'],
            'status': authentic['status'],
            'terminalReason': authentic['terminalReason'],
            'score': report['score'],
            'stateHash': report['stateHash'],
          }
        : report;
    final mismatches = _clientReportMismatches(finalState, client);
    out['ok'] = true;
    out['replayOk'] = true;
    out['fullCompareOk'] = mismatches.isEmpty;
    out['mismatches'] = mismatches;
    out['authenticStateHash'] = stateHashV3(finalState);
    return;
  }
  out['ok'] = false;
  out['reason'] = 'unsupported_replay_security_id';
}

List<String> _clientReportMismatches(
  GameState replayed,
  Map<String, Object?> client,
) {
  final expected = replayed.toJson();
  final mismatches = <String>[];
  if (client['score'] != replayed.score) mismatches.add('score_mismatch');
  if (client['turnsUsed'] != replayed.turnsUsed)
    mismatches.add('turn_mismatch');
  if (client['status'] != expected['status'])
    mismatches.add('terminal_mismatch');
  if (client['terminalReason'] != expected['terminalReason']) {
    mismatches.add('terminal_mismatch');
  }
  if (!_deepEqual(client['board'], expected['cells'])) {
    mismatches.add('board_mismatch');
  }
  if (!_deepEqual(client['offers'], expected['offers'])) {
    mismatches.add('offer_mismatch');
  }
  if (client['stateHash'] != stateHashV3(replayed)) {
    mismatches.add('state_hash_mismatch');
  }
  return mismatches.toSet().toList();
}

bool _deepEqual(Object? a, Object? b) {
  if (identical(a, b)) return true;
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !_deepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!_deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

Map<String, Object?> _replay(Object? initial, List<Object?> moves) {
  var state = parseInitialGameState(initial);
  for (final raw in moves) {
    final result = applyMove(state, parseMove(raw));
    if (result is! MoveApplied) {
      return {'ok': false, 'result': result.runtimeType.toString()};
    }
    state = result.finalState;
  }
  return {
    'ok': true,
    'finalState': state.toJson(),
    'stateHash': stateHashV3(state),
  };
}
