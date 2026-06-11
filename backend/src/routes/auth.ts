//REGISTER
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { supabase } from '../supabase';
interface RegisterBody {
  email: string;
  password?: string;
  username: string;
}

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/register', async (request: FastifyRequest<{ Body: RegisterBody }>, reply: FastifyReply) => {
    const { email, password, username } = request.body;

    if (!email || !password) {
      return reply.status(400).send({ error: 'Email and password are required' });
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true // CONFIRMS EMAIL FOR LOCAL DEV #FIX
    });

    if (authError || !authData.user) {
      return reply.status(400).send({ error: authError?.message || 'Failed to create user' });
    }

    const userId = authData.user.id; //uuid
    const { error: dbError } = await supabase
      .from('users') 
      .insert([
        { 
            id: userId,
            username: username,
        }
      ]);

    if (dbError) {
      await supabase.auth.admin.deleteUser(userId);
      return reply.status(500).send({ error: 'Failed to create user profile', details: dbError.message });
    }

    return reply.status(201).send({ message: 'User registered successfully!', userId });
  });
}