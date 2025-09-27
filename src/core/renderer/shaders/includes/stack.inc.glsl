
#define STACK_SIZE 16

struct Stack {
    vec3 data[STACK_SIZE];
    int topIndex;
};

void initStack(out Stack stack) {
    stack.topIndex = -1;
}

bool push(inout Stack stack, vec3 value) {
    if (stack.topIndex >= STACK_SIZE - 1) {
        return false; // Stack is full
    }
    stack.topIndex++;
    stack.data[stack.topIndex] = value;
    return true;
}

vec3 pop(inout Stack stack) {
    if (stack.topIndex < 0) {
        return vec3(0.0); // Stack is empty, return default
    }
    vec3 value = stack.data[stack.topIndex];
    stack.topIndex--;
    return value;
}

vec3 top(Stack stack) {
    if (stack.topIndex < 0) {
        return vec3(0.0); // Stack is empty, return default
    }
    return stack.data[stack.topIndex];
}

bool swapTop(inout Stack stack, vec3 value) {
    if (stack.topIndex < 0) {
        return false; // Stack is empty
    }
    stack.data[stack.topIndex] = value;
    return true;
}

