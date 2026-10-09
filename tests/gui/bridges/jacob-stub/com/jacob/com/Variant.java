package com.jacob.com;

/** Stand-in for JACOB's Variant: holds a Java value or a Dispatch. TEST DOUBLE - not the real library. */
public class Variant {
    private final Object value;

    public Variant(Object value) {
        this.value = value;
    }

    public Object toJavaObject() {
        return value;
    }

    public Dispatch toDispatch() {
        if (value instanceof Dispatch) return (Dispatch) value;
        throw new ComFailException("The value is not an object");
    }

    public boolean getBoolean() {
        return Boolean.TRUE.equals(value);
    }

    public int getInt() {
        return ((Number) value).intValue();
    }
}
