package core

import (
	"errors"
	"fmt"
)

// OpError is the stable, typed error returned across the JSON-lines boundary.
// Details must only contain JSON-serializable values.
type OpError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Cause   error          `json:"-"`
}

func (e *OpError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func (e *OpError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Cause
}

func opError(code, message string, cause error, details map[string]any) *OpError {
	return &OpError{Code: code, Message: message, Cause: cause, Details: details}
}

func AsOpError(err error) *OpError {
	if err == nil {
		return nil
	}
	var typed *OpError
	if errors.As(err, &typed) {
		return typed
	}
	return &OpError{
		Code:    "internal_error",
		Message: "The core could not complete the request.",
		Cause:   err,
		Details: map[string]any{"cause": fmt.Sprintf("%T", err)},
	}
}
