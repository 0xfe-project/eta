package queue

import (
	"context"
	"log/slog"
	"time"

	"github.com/nats-io/jwt/v2"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nkeys"
)

// Agent runtimes share the NATS server with the services but not its
// subjects: a runtime connects with its runtime key as its token, the server
// asks the control plane who that is (auth callout, deploy/nats.conf), and
// the answer lets the connection use only its own agent's subjects. So no
// agent can steer, stop or decide for another, read or empty its queue, or
// fire a routine, and runtimes get no credential beyond the key they have.

// Account is the NATS account of the services and the runtimes.
const Account = "AXP"

// authSubject is where the server asks.
const authSubject = "$SYS.REQ.USER.AUTH"

// InboxPrefix is a runtime's inbox prefix (its replies come there); a
// runtime may read only its own.
func InboxPrefix(agentID string) string { return "_INBOX_" + agentID }

// RuntimePermissions are what a runtime of the agent may do: take from and
// ack its consumer, hear its control subject and answer what it hears.
func RuntimePermissions(agentID string) jwt.Permissions {
	var p jwt.Permissions
	consumer := Stream + "." + ConsumerName(agentID)
	p.Pub.Allow.Add(
		"$JS.API.CONSUMER.MSG.NEXT."+consumer,
		"$JS.API.CONSUMER.INFO."+consumer,
		"$JS.ACK."+consumer+".>",
	)
	p.Sub.Allow.Add(ControlSubject(agentID), InboxPrefix(agentID)+".>")
	// A control request's reply subject is the asker's inbox.
	p.Resp = &jwt.ResponsePermission{MaxMsgs: 1, Expires: time.Minute}
	return p
}

// Authenticate is which agent holds a runtime key, or an error.
type Authenticate func(ctx context.Context, key string) (agentID string, err error)

// ServeAuth answers the server's auth callout until ctx ends, signing with
// the account key whose seed is issuerSeed (deploy/nats.conf names its
// public key). Every process serving it shares the work.
func (q *NATS) ServeAuth(ctx context.Context, issuerSeed string, authenticate Authenticate) error {
	issuer, err := nkeys.FromSeed([]byte(issuerSeed))
	if err != nil {
		return err
	}
	sub, err := q.nc.QueueSubscribe(authSubject, "auth", func(msg *nats.Msg) {
		answer, err := authorize(ctx, issuer, msg.Data, authenticate)
		if err != nil {
			slog.ErrorContext(ctx, "Cannot answer a NATS auth callout", "error", err)
			return
		}
		_ = msg.Respond(answer)
	})
	if err != nil {
		return err
	}
	<-ctx.Done()
	return sub.Unsubscribe()
}

// authorize answers one auth callout request: the runtime's agent as a user
// limited to its subjects, or why not.
func authorize(ctx context.Context, issuer nkeys.KeyPair, request []byte, authenticate Authenticate) ([]byte, error) {
	req, err := jwt.DecodeAuthorizationRequestClaims(string(request))
	if err != nil {
		return nil, err
	}
	resp := jwt.NewAuthorizationResponseClaims(req.UserNkey)
	resp.Audience = req.Server.ID
	agentID, err := authenticate(ctx, req.ConnectOptions.Token)
	if err != nil || agentID == "" {
		resp.Error = "not an agent runtime"
	} else {
		user := jwt.NewUserClaims(req.UserNkey)
		user.Name = "agent-" + agentID
		user.Audience = Account
		user.Permissions = RuntimePermissions(agentID)
		if resp.Jwt, err = user.Encode(issuer); err != nil {
			return nil, err
		}
	}
	token, err := resp.Encode(issuer)
	return []byte(token), err
}
