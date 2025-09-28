// stack.inc.glsl — register-only implementation (drop-in)

#ifndef STACK_SIZE
#define STACK_SIZE 3
#endif

struct Stack {
    int topIndex;
#if STACK_SIZE > 0
    vec3 _s0;
#endif
#if STACK_SIZE > 1
    vec3 _s1;
#endif
#if STACK_SIZE > 2
    vec3 _s2;
#endif
#if STACK_SIZE > 3
    vec3 _s3;
#endif
#if STACK_SIZE > 4
    vec3 _s4;
#endif
#if STACK_SIZE > 5
    vec3 _s5;
#endif
#if STACK_SIZE > 6
    vec3 _s6;
#endif
#if STACK_SIZE > 7
    vec3 _s7;
#endif
#if STACK_SIZE > 8
    vec3 _s8;
#endif
#if STACK_SIZE > 9
    vec3 _s9;
#endif
#if STACK_SIZE > 10
    vec3 _s10;
#endif
#if STACK_SIZE > 11
    vec3 _s11;
#endif
#if STACK_SIZE > 12
    vec3 _s12;
#endif
#if STACK_SIZE > 13
    vec3 _s13;
#endif
#if STACK_SIZE > 14
    vec3 _s14;
#endif
#if STACK_SIZE > 15
    vec3 _s15;
#endif
};

// ---- internal helpers: constant-target access (no dynamic indices) ----
vec3 _stackGetSlot(const Stack s, int idx) {
#if STACK_SIZE > 0
    if (idx == 0) return s._s0;
#endif
#if STACK_SIZE > 1
    if (idx == 1) return s._s1;
#endif
#if STACK_SIZE > 2
    if (idx == 2) return s._s2;
#endif
#if STACK_SIZE > 3
    if (idx == 3) return s._s3;
#endif
#if STACK_SIZE > 4
    if (idx == 4) return s._s4;
#endif
#if STACK_SIZE > 5
    if (idx == 5) return s._s5;
#endif
#if STACK_SIZE > 6
    if (idx == 6) return s._s6;
#endif
#if STACK_SIZE > 7
    if (idx == 7) return s._s7;
#endif
#if STACK_SIZE > 8
    if (idx == 8) return s._s8;
#endif
#if STACK_SIZE > 9
    if (idx == 9) return s._s9;
#endif
#if STACK_SIZE > 10
    if (idx == 10) return s._s10;
#endif
#if STACK_SIZE > 11
    if (idx == 11) return s._s11;
#endif
#if STACK_SIZE > 12
    if (idx == 12) return s._s12;
#endif
#if STACK_SIZE > 13
    if (idx == 13) return s._s13;
#endif
#if STACK_SIZE > 14
    if (idx == 14) return s._s14;
#endif
#if STACK_SIZE > 15
    if (idx == 15) return s._s15;
#endif
    return vec3(0.0);
}

void _stackSetSlot(inout Stack s, int idx, vec3 v) {
#if STACK_SIZE > 0
    if (idx == 0) { s._s0 = v; return; }
#endif
#if STACK_SIZE > 1
    if (idx == 1) { s._s1 = v; return; }
#endif
#if STACK_SIZE > 2
    if (idx == 2) { s._s2 = v; return; }
#endif
#if STACK_SIZE > 3
    if (idx == 3) { s._s3 = v; return; }
#endif
#if STACK_SIZE > 4
    if (idx == 4) { s._s4 = v; return; }
#endif
#if STACK_SIZE > 5
    if (idx == 5) { s._s5 = v; return; }
#endif
#if STACK_SIZE > 6
    if (idx == 6) { s._s6 = v; return; }
#endif
#if STACK_SIZE > 7
    if (idx == 7) { s._s7 = v; return; }
#endif
#if STACK_SIZE > 8
    if (idx == 8) { s._s8 = v; return; }
#endif
#if STACK_SIZE > 9
    if (idx == 9) { s._s9 = v; return; }
#endif
#if STACK_SIZE > 10
    if (idx == 10) { s._s10 = v; return; }
#endif
#if STACK_SIZE > 11
    if (idx == 11) { s._s11 = v; return; }
#endif
#if STACK_SIZE > 12
    if (idx == 12) { s._s12 = v; return; }
#endif
#if STACK_SIZE > 13
    if (idx == 13) { s._s13 = v; return; }
#endif
#if STACK_SIZE > 14
    if (idx == 14) { s._s14 = v; return; }
#endif
#if STACK_SIZE > 15
    if (idx == 15) { s._s15 = v; return; }
#endif
}

// ---- public API (unchanged) ----
void initStack(inout Stack stack) {
    stack.topIndex = -1;
}

bool push(inout Stack stack, vec3 value) {
    if (stack.topIndex >= STACK_SIZE - 1) {
        return false; // full
    }
    int next = stack.topIndex + 1;
    _stackSetSlot(stack, next, value);
    stack.topIndex = next;
    return true;
}

vec3 pop(inout Stack stack) {
    if (stack.topIndex < 0) {
        return vec3(0.0); // empty
    }
    vec3 v = _stackGetSlot(stack, stack.topIndex);
    stack.topIndex -= 1;
    return v;
}

vec3 top(inout Stack stack) {
    if (stack.topIndex < 0) {
        return vec3(0.0); // empty
    }
    return _stackGetSlot(stack, stack.topIndex);
}

bool swapTop(inout Stack stack, vec3 value) {
    if (stack.topIndex < 0) {
        return false; // empty
    }
    _stackSetSlot(stack, stack.topIndex, value);
    return true;
}
